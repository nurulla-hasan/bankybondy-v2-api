import httpStatus from 'http-status';
import mongoose from 'mongoose';
import QueryBuilder from '../../builder/QueryBuilder';
import AppError from '../../error/appError';
import { analyzeConversationAudio } from '../../helper/audioAnalyzer';
import { deleteFileFromS3 } from '../../helper/deleteFromS3';
import { errorLogger, logger } from '../../shared/logger';
import { clampLimit, clampPage } from '../../utilities/pagination';
import { getMediaUrl } from '../../utilities/signedUrl';
import AudioBookmark from '../audioBookmark/audio.bookmark.model';
import {
    getBlockedIdsFor,
    getBlockedObjectIdsFor,
} from '../userBlock/userBlock.service';
import {
    ENUM_AUDIO_MODERATION_STATUS,
    IAudio,
} from './audio.interface';
import Audio, { AudioComment, AudioListen, AudioRating } from './audio.model';
import {
    FEELING_TAGS,
    isValidFeelingTag,
    normalizeFeelingTags,
} from './feelingTags';
import { isTextSafeBatch, assertTextAllowed } from '../../helper/isTextSafe';
import { collectAudioTexts } from './audio.moderation';
import { moderateImageUrl } from '../../helper/moderateImage';
import { isQualifiedListen, dayBucketFor } from './audio.listen';

// Redondea a 1 decimal el promedio de estrellas a partir de los contadores
// almacenados en el propio audio (totalRating/ratingCount). 0 si no hay votos.
const computeAverageRating = (
    totalRating?: number,
    ratingCount?: number
): number => {
    if (!ratingCount || ratingCount <= 0) return 0;
    return Math.round(((totalRating || 0) / ratingCount) * 10) / 10;
};

// Agrega los feeling tags de TODO el feedback de un audio y devuelve
// [{ tag, count }] ordenado desc. Opcionalmente recorta a "limit".
const getFeelingCountsForAudio = async (
    audioId: mongoose.Types.ObjectId | string,
    limit?: number,
    blockedCommentorIds?: mongoose.Types.ObjectId[]
): Promise<{ tag: string; count: number }[]> => {
    // Bloqueo entre usuarios: no contar las sensaciones dejadas por comentaristas
    // bloqueados. Mismo criterio que la lista visible de feedback (que ya filtra
    // `commentor $nin`). Sin esto los agregados sumaban feedback oculto ("fantasma").
    const match: Record<string, unknown> = {
        audio: new mongoose.Types.ObjectId(audioId),
    };
    if (blockedCommentorIds && blockedCommentorIds.length) {
        match.commentor = { $nin: blockedCommentorIds };
    }
    const pipeline: mongoose.PipelineStage[] = [
        { $match: match },
        { $unwind: '$feelingTags' },
        { $group: { _id: '$feelingTags', count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
    ];
    if (limit && limit > 0) pipeline.push({ $limit: limit });
    pipeline.push({
        $project: { _id: 0, tag: '$_id', count: 1 },
    });
    return AudioComment.aggregate(pipeline);
};

// Firma las URLs de medios (CloudFront) si esta configurado el key pair.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const withSignedMedia = (doc: any) => {
    if (!doc) return doc;
    const o = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    if (o.audio_url) o.audio_url = getMediaUrl(o.audio_url);
    if (o.cover_image) o.cover_image = getMediaUrl(o.cover_image);
    return o;
};

// Create Audio
// D.5 (Tanda 2): la subida NO bloquea la UI. Se crea el registro en estado
// 'processing' y se devuelve de inmediato; la moderacion por IA + verificacion
// corre en segundo plano (processAudioModeration) y luego pasa a 'ready' o
// 'rejected'. El front consulta el estado por getModerationStatus / los getters.
// Modera los textos públicos del audio (título/descripción/tags) con la misma
// política que offer/want de vínculos: lanza 400 si algo no está permitido, y NO
// bloquea por "moderación caída" (assertTextAllowed distingue ambos casos).
const moderateAudioTexts = async (payload: Partial<IAudio>): Promise<void> => {
    const texts = collectAudioTexts(payload);
    if (!texts.length) return;
    const verdicts = await isTextSafeBatch(texts.map((t) => t.text));
    verdicts.forEach((v, i) => assertTextAllowed(v, texts[i].label));
};

const createAudio = async (userId: string, payload: IAudio) => {
    // Campos controlados por el servidor: nunca desde el cliente
    const {
        totalPlay,
        trendingScore,
        totalRating,
        ratingCount,
        isBlocked,
        // El estado de moderacion lo controla el servidor, no el cliente.
        moderationStatus,
        moderationReason,
        ...safePayload
    } = payload as Partial<IAudio>;

    // Moderar título/descripción/tags ANTES de crear (eran texto público del
    // cliente que nunca pasaba por moderación → bypass de T&S).
    await moderateAudioTexts(safePayload);

    const result = await Audio.create({
        ...safePayload,
        user: userId,
        moderationStatus: ENUM_AUDIO_MODERATION_STATUS.PROCESSING,
        moderationReason: '',
    });
    return result;
};

/**
 * D.5 (Tanda 2): procesamiento pesado en segundo plano. Corre la moderacion por
 * IA YA configurada (analyzeConversationAudio: transcode + transcripcion +
 * chequeo de dialogo real / censura) sobre el audio ya subido a S3 y actualiza
 * el estado del registro. Fire-and-forget: se llama sin await desde el
 * controller. NO agrega llamadas de IA nuevas: reutiliza el analizador existente.
 */
// NINGÚN VEREDICTO SE ESCRIBE SÓLO POR ID: SIEMPRE CONTRA LO QUE SE ANALIZÓ.
//
// "Lo que se analizó" es el AUDIO en tres de los cuatro veredictos, y el audio Y
// LA PORTADA en el cuarto —el rechazo por portada—, que lleva `cover_image` en su
// propio filtro. La excepción está escrita ahí abajo y es deliberada.
//
// Este análisis corre en segundo plano y tarda minutos. Mientras tanto el dueño
// puede reemplazar el archivo desde "Editar" — y lo hace, porque "Mi contenido"
// no muestra el estado de moderación y un audio trabado se ve igual que uno
// publicado. Con las escrituras keyeadas sólo por `_id` pasaban dos cosas, las
// dos malas:
//
//   · el veredicto VIEJO caía sobre el archivo NUEVO: un READY publicaba sin
//     moderar algo que nadie analizó;
//   · y el rechazo por contenido releía el documento al final y borraba de S3
//     `audio.audio_url` — o sea, **el archivo nuevo**. La persona perdía la
//     grabación y recibía un rechazo que hablaba de otro audio.
//
// Con el filtro `{ _id, audio_url, moderationStatus: 'processing' }` el veredicto
// huérfano no escribe nada: es un no-op, el documento se queda como está y el
// sweep lo rescata para que lo analice la pasada que sí corresponde al archivo
// actual.
//
// LOS BORRADOS DE S3 VAN TODOS DETRÁS DEL SELLO, sin excepción. La regla no es
// "el valor que se borra es el que se juzgó" —eso es cierto y no alcanza—: es que
// el DOCUMENTO siga apuntando a ese archivo. Si la escritura fue no-op, alguien
// más mandó, y borrar deja un objeto muerto referenciado por un campo `required`.
const processAudioModeration = async (
    audioId: string,
    audioUrl: string
): Promise<void> => {
    // Escribe el veredicto sólo si el audio sigue siendo el que se analizó Y sigue
    // esperando veredicto. Devuelve true si escribió.
    //
    // `moderationStatus: PROCESSING` en el filtro (panel del 26/9) convierte esto
    // en PRIMER-ESCRITOR-GANA y cierra la concurrencia entre dos pasadas sobre el
    // MISMO archivo — el caso que `audio_url` no puede distinguir, porque es lo
    // único idéntico entre las dos. Pasa cuando la pasada supera los 10 minutos de
    // `AUDIO_STUCK_MINUTES` y el sweep, desde el otro proceso de PM2, la reclama
    // creyéndola colgada. Sin esto, la pasada perdedora podía dejar el audio READY
    // en el feed con su objeto de S3 ya borrado por la hermana.
    //
    // Los cuatro estados de entrada verificados contra el código: alta, updateAudio
    // y los dos pools del sweep dejan el documento en 'processing'. Ninguno se rompe.
    const sellarVeredicto = async (campos: Record<string, unknown>) => {
        const r = await Audio.updateOne(
            {
                _id: audioId,
                audio_url: audioUrl,
                moderationStatus: ENUM_AUDIO_MODERATION_STATUS.PROCESSING,
            },
            campos
        );
        if (r.matchedCount === 0) {
            // Sin afirmar la causa: pudo cambiar el archivo, pudo ganar otra
            // pasada, pudo borrarse el documento. Se registra el hecho, no el
            // motivo (convención de matching.compute.ts).
            logger.info(
                `[audio] veredicto descartado: ${audioId} ya no está esperando este análisis.`
            );
        }
        return r.matchedCount > 0;
    };

    try {
        // analyzeConversationAudio ahora garantiza un VEREDICTO de contenido:
        // devuelve valid_conversation boolean (true/false). Los errores tecnicos
        // (red/S3/ffmpeg/OpenAI/timeout/JSON malformado) se propagan como
        // excepcion y caen al catch. Asi distinguimos contenido vs tecnico.
        const analysis = await analyzeConversationAudio(audioUrl);
        // Aprobar SOLO si es dialogo valido Y NO tiene contenido prohibido
        // (sexual / drogas / armas / violencia / delitos). Si hay contenido
        // prohibido, cae al rechazo por contenido (marca 'rejected' + borra S3).
        if (
            analysis?.valid_conversation === true &&
            analysis?.prohibited_content === false
        ) {
            // Audio OK → moderar la PORTADA (imagen). El cover_image se guarda como
            // URL de CloudFront; se FIRMA (getMediaUrl) por si el CDN pasa a acceso
            // restringido, para que OpenAI la pueda bajar (si no, daría 403 →
            // fail-open silencioso).
            const doc = await Audio.findById(audioId)
                .select('cover_image')
                .lean();
            const cover = await moderateImageUrl(
                getMediaUrl(doc?.cover_image || '')
            );
            if (!cover.checked) {
                // No se pudo verificar la portada (OpenAI caído/429/etc.): NO se
                // aprueba. Se lanza para caer al catch técnico → FAILED → el sweep
                // reintenta (misma política que el análisis de audio; nunca publica
                // una portada sin moderar).
                throw new Error('Cover moderation unavailable — will retry');
            }
            if (!cover.safe) {
                // El sello de ESTA rama lleva además `cover_image`, y sólo ésta.
                // Motivo: un rechazo por una portada que el dueño ya reemplazó no
                // debe escribir REJECTED terminal sobre la portada nueva —que nadie
                // juzgó—, y `updateAudio` no cambia el estado cuando se reemplaza
                // sólo la portada, así que el filtro de `sellarVeredicto` no lo
                // distingue. NO se mete `cover_image` adentro de `sellarVeredicto`
                // para todos los caminos: un READY keyeado por la portada quedaría
                // en no-op ante cualquier cambio de portada y costaría un análisis
                // completo de más.
                const r = await Audio.updateOne(
                    {
                        _id: audioId,
                        audio_url: audioUrl,
                        cover_image: doc?.cover_image,
                        moderationStatus:
                            ENUM_AUDIO_MODERATION_STATUS.PROCESSING,
                    },
                    {
                        moderationStatus:
                            ENUM_AUDIO_MODERATION_STATUS.REJECTED,
                        moderationReason: `Cover image rejected: ${cover.reason}`,
                    }
                );
                const sello = r.matchedCount > 0;
                if (!sello) {
                    // El log que le falta a esta copia y que `sellarVeredicto` sí
                    // tiene. Es el ÚNICO de los cuatro veredictos que es de T&S, y
                    // era el único cuyo descarte no dejaba rastro.
                    logger.info(
                        `[audio] veredicto de portada descartado: ${audioId} ya no está esperando este análisis.`
                    );
                }
                // Se borra SOLO la portada (la imagen dictaminada NSFW no debe
                // seguir sirviéndose por su URL de CloudFront); se CONSERVA el audio
                // (pasó moderación; puede ser un falso positivo de la imagen).
                //
                // DETRÁS DEL SELLO, y esto lo corrigió la segunda ronda del panel.
                // Yo lo había dejado incondicional razonando que el valor borrado es
                // el mismo que se juzgó — cierto, pero la conclusión no se sigue: lo
                // que hace seguro un borrado no es la identidad del valor juzgado,
                // es que el DOCUMENTO siga apuntándolo. Con el sello pudiendo ser
                // no-op, borrar igual dejaba un estado que antes era imposible:
                // objeto de S3 borrado, documento todavía en 'processing' y
                // `cover_image` (required) apuntando a algo que ya no existe — del
                // que las pasadas siguientes salen por FAILED cinco veces, quemando
                // un análisis completo cada una, sin publicar nunca.
                //
                // Si no se borra, se auto-cura en DOS de las tres causas del no-op,
                // no en las tres (medido en la tercera ronda del panel):
                //   · cambió la portada → `updateAudio` ya borró la vieja de S3, así
                //     que no sobrevive ninguna imagen prohibida;
                //   · cambió el audio → queda en 'processing' y arranca otra pasada,
                //     que rejuzga la misma portada;
                //   · el estado ya NO es 'processing' —ganó una pasada hermana— →
                //     ahí no hay pasada siguiente y la imagen queda viva. Es el
                //     único caso que no se cura solo, exige que dos pasadas
                //     DISCREPEN sobre la misma imagen, y desde ahora deja rastro en
                //     el log de arriba en vez de ser invisible.
                // En todos los casos el audio no aparece en el feed, que sólo lista
                // los READY.
                if (sello && doc?.cover_image) deleteFileFromS3(doc.cover_image);
                return;
            }
            // Aprobado por contenido (audio + portada).
            await sellarVeredicto({
                moderationStatus: ENUM_AUDIO_MODERATION_STATUS.READY,
                moderationReason: '',
            });
        } else {
            // Rechazo por CONTENIDO (veredicto explicito de la IA): se marca
            // 'rejected' y se limpian los archivos de S3 (el audio no es valido).
            //
            // El orden importa y es lo contrario de lo que había: PRIMERO se sella
            // —que es la operación atómica que decide si este veredicto todavía
            // manda— y sólo después se borra. Antes se releía el documento y se
            // borraba `audio.audio_url`, que para entonces podía ser el archivo
            // NUEVO que alguien acababa de subir.
            const audio = await Audio.findById(audioId).lean();
            const sello = await sellarVeredicto({
                moderationStatus: ENUM_AUDIO_MODERATION_STATUS.REJECTED,
                moderationReason:
                    analysis?.reason ||
                    'Audio rejected: it must be a real conversation and must not contain prohibited content.',
            });
            if (sello) {
                // `audioUrl` y no `audio.audio_url`: se borra EXACTAMENTE el
                // archivo que se juzgó. El sello ya garantiza que son el mismo,
                // pero decirlo en el código hace imposible la regresión.
                deleteFileFromS3(audioUrl);
                if (audio?.cover_image) deleteFileFromS3(audio.cover_image);
            }
        }
    } catch (e) {
        // Fallo TECNICO del pipeline (descarga/ffmpeg/OpenAI/timeout/JSON): NO es
        // un veredicto de contenido. Se marca 'failed' con motivo tecnico y se
        // CONSERVAN los archivos de S3 para no perder un audio valido; podra
        // reprocesarse/reintentarse. No queda colgado en 'processing'.
        errorLogger.error(
            '[audio] moderacion en background fallo (tecnico):',
            (e as Error)?.message
        );
        try {
            // También sellado: si el archivo ya fue reemplazado, este fallo es del
            // audio VIEJO y marcarlo 'failed' pisaría el 'processing' legítimo del
            // nuevo — que está siendo analizado ahora mismo por otra pasada.
            await sellarVeredicto({
                moderationStatus: ENUM_AUDIO_MODERATION_STATUS.FAILED,
                moderationReason:
                    'Could not process audio due to a technical error. It will be retried.',
            });
            // Importante: NO borrar S3 aca. El audio puede ser valido.
        } catch {
            /* noop */
        }
    }
};

// D.5: estado de moderacion para que el front haga polling del progreso.
const getModerationStatus = async (userId: string, audioId: string) => {
    const audio = await Audio.findOne({ _id: audioId, user: userId })
        .select('moderationStatus moderationReason')
        .lean();
    if (!audio) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    return {
        _id: audioId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        moderationStatus: (audio as any).moderationStatus,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        moderationReason: (audio as any).moderationReason || '',
    };
};

// Get All Audios with QueryBuilder
// Feed "Estamos charlando". Si viene profileId (rol user), se excluyen los
// audios de usuarios bloqueados (en ambos sentidos, B.4).
const getAllAudios = async (
    query: Record<string, unknown>,
    profileId?: string
) => {
    // D.5 (Tanda 2): el feed solo muestra audios aprobados por la moderacion
    // asincrona (moderationStatus 'ready'). Los 'processing'/'rejected' quedan
    // fuera hasta que el worker en segundo plano los apruebe.
    const baseFilter: Record<string, unknown> = {
        isBlocked: false,
        moderationStatus: ENUM_AUDIO_MODERATION_STATUS.READY,
    };
    const blockedObjectIds = profileId
        ? await getBlockedObjectIdsFor(profileId)
        : [];
    if (blockedObjectIds.length) {
        baseFilter.user = { $nin: blockedObjectIds };
    }
    const audioQuery = new QueryBuilder(
        Audio.find(baseFilter)
            .populate('audioTopic')
            .populate({
                path: 'user',
                select: 'name profile_image',
                model: 'NormalUser',
            }),
        query
    )
        .search(['title', 'description'])
        .filter()
        .sort()
        .paginate()
        .fields();

    const result = await audioQuery.modelQuery;
    const meta = await audioQuery.countTotal();

    // Enriquecimiento del feed: por cada tarjeta de esta pagina se agrega
    // averageRating (de los contadores ya guardados), commentCount y las 3
    // sensaciones mas votadas. Las agregaciones se acotan a los audios de la
    // pagina (no a toda la coleccion) para mantenerlas eficientes.
    const cards = (result as unknown[]).map(withSignedMedia);
    const audioIds = cards
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => c?._id)
        .filter(Boolean)
        .map((id: unknown) => new mongoose.Types.ObjectId(String(id)));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let enriched: any[] = cards;
    if (audioIds.length) {
        // Bloqueo entre usuarios: los agregados de feedback tampoco cuentan a los
        // comentaristas bloqueados (mismo criterio que la lista visible). Sin esto
        // el feed mostraba conteos "fantasma" que incluían feedback oculto.
        const commentMatch: Record<string, unknown> = {
            audio: { $in: audioIds },
        };
        if (blockedObjectIds.length) {
            commentMatch.commentor = { $nin: blockedObjectIds };
        }
        // commentCount por audio (numero de documentos de feedback).
        const countAgg = await AudioComment.aggregate([
            { $match: commentMatch },
            { $group: { _id: '$audio', count: { $sum: 1 } } },
        ]);
        const commentCountMap = new Map<string, number>();
        for (const row of countAgg) {
            commentCountMap.set(String(row._id), row.count);
        }

        // Top feeling tags por audio (ordenados desc); luego se recortan a 3.
        const feelingsAgg = await AudioComment.aggregate([
            { $match: commentMatch },
            { $unwind: '$feelingTags' },
            {
                $group: {
                    _id: { audio: '$audio', tag: '$feelingTags' },
                    count: { $sum: 1 },
                },
            },
            { $sort: { count: -1, '_id.tag': 1 } },
            {
                $group: {
                    _id: '$_id.audio',
                    feelings: {
                        $push: { tag: '$_id.tag', count: '$count' },
                    },
                },
            },
        ]);
        const feelingsMap = new Map<
            string,
            { tag: string; count: number }[]
        >();
        for (const row of feelingsAgg) {
            feelingsMap.set(String(row._id), (row.feelings || []).slice(0, 3));
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        enriched = cards.map((card: any) => {
            const id = String(card?._id);
            return {
                ...card,
                averageRating: computeAverageRating(
                    card?.totalRating,
                    card?.ratingCount
                ),
                commentCount: commentCountMap.get(id) || 0,
                topFeelings: feelingsMap.get(id) || [],
            };
        });
    }

    return {
        meta,
        result: enriched,
    };
};

// Get All audios with QueryBuilder
const getMyAudios = async (userId: string, query: Record<string, unknown>) => {
    const audioQuery = new QueryBuilder(
        Audio.find({ user: userId }).populate('audioTopic'),
        query
    )
        .search(['title', 'description'])
        .filter()
        .sort()
        .paginate()
        .fields();

    const result = await audioQuery.modelQuery;
    const meta = await audioQuery.countTotal();

    return {
        meta,
        result: (result as unknown[]).map(withSignedMedia),
    };
};

// Charlas publicas de un usuario para su pagina de perfil. Lista ligera: solo
// audios aprobados por la moderacion ('ready') y no bloqueados del usuario dado.
// Proyeccion + limit + lean para mantenerla rapida. Firma cover_image/audio_url
// (CloudFront) para que el mini-player pueda reproducirlas y agrega averageRating.
const getAudiosByUser = async (userId: string, viewerId?: string) => {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid user id');
    }

    // B.4: si el visitante y el dueno del perfil estan en una relacion de
    // bloqueo (en cualquier sentido), no se exponen sus charlas: lista vacia.
    if (viewerId) {
        const blockedIds = await getBlockedIdsFor(viewerId);
        if (blockedIds.includes(userId)) {
            return [];
        }
    }

    const audios = await Audio.find({
        user: userId,
        moderationStatus: ENUM_AUDIO_MODERATION_STATUS.READY,
        isBlocked: false,
    })
        .select(
            'title description cover_image audio_url duration audioTopic totalPlay totalRating ratingCount'
        )
        .populate('audioTopic')
        .sort('-createdAt')
        .limit(12)
        .lean();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (audios as any[]).map((audio) => {
        const signed = withSignedMedia(audio);
        return {
            ...signed,
            averageRating: computeAverageRating(
                signed?.totalRating,
                signed?.ratingCount
            ),
        };
    });
};

// Get Audio by ID
// Solo se expone si el audio esta 'ready' (aprobado) o si el solicitante es el
// DUENO (para que pueda ver el estado de su propio audio en proceso). Los estados
// 'processing'/'rejected'/'failed' no se exponen a terceros. Tambien se ocultan
// los audios bloqueados por ID directo.
const getAudioById = async (audioId: string, requesterId?: string) => {
    if (!mongoose.Types.ObjectId.isValid(audioId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid audio id');
    }
    const audio = await Audio.findById(audioId)
        .populate('audioTopic')
        .populate({
            path: 'user',
            select: 'name profile_image',
            model: 'NormalUser',
        });
    if (!audio) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    // No exponer audios bloqueados por ID directo.
    if ((audio as unknown as { isBlocked?: boolean }).isBlocked) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    const status = (audio as unknown as { moderationStatus?: string })
        .moderationStatus;
    const ownerId =
        (audio as unknown as { user?: { _id?: { toString(): string } } }).user
            ?._id?.toString() ??
        (audio as unknown as { user?: { toString(): string } }).user?.toString();
    const isOwner = !!requesterId && ownerId === requesterId;
    // Solo 'ready' es visible a terceros; el dueno ve cualquier estado propio.
    if (status !== ENUM_AUDIO_MODERATION_STATUS.READY && !isOwner) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }

    // B.4: si el dueno del audio y el solicitante estan en una relacion de
    // bloqueo (en cualquier sentido), el audio no existe para el solicitante.
    if (requesterId && !isOwner && ownerId) {
        const blockedIds = await getBlockedIdsFor(requesterId);
        if (blockedIds.includes(ownerId)) {
            throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base: any = withSignedMedia(audio);

    // Agregados del sistema de feedback: promedio de estrellas, numero de
    // valoraciones, numero de comentarios y las 6 sensaciones mas votadas. Bloqueo
    // entre usuarios: los conteos excluyen a los comentaristas bloqueados (mismo
    // criterio que la lista visible), para no mostrar feedback "fantasma".
    const feedbackBlockedIds = requesterId
        ? await getBlockedObjectIdsFor(requesterId)
        : [];
    const commentMatch: Record<string, unknown> = { audio: audioId };
    if (feedbackBlockedIds.length) {
        commentMatch.commentor = { $nin: feedbackBlockedIds };
    }
    const [commentCount, topFeelings] = await Promise.all([
        AudioComment.countDocuments(commentMatch),
        getFeelingCountsForAudio(audioId, 6, feedbackBlockedIds),
    ]);

    base.averageRating = computeAverageRating(
        base?.totalRating,
        base?.ratingCount
    );
    base.ratingCount = base?.ratingCount || 0;
    base.commentCount = commentCount;
    base.topFeelings = topFeelings;

    // Si el solicitante esta autenticado, se adjunta su propia interaccion.
    if (requesterId) {
        const [myRatingDoc, myFeelingDoc] = await Promise.all([
            AudioRating.findOne({ user: requesterId, audio: audioId })
                .select('rating')
                .lean(),
            AudioComment.findOne({
                commentor: requesterId,
                audio: audioId,
            })
                .select('text feelingTags createdAt updatedAt')
                .lean(),
        ]);
        base.myRating =
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (myRatingDoc as any)?.rating ?? null;
        base.myFeeling = myFeelingDoc
            ? {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  text: (myFeelingDoc as any).text || '',
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  feelingTags: (myFeelingDoc as any).feelingTags || [],
              }
            : null;
    } else {
        base.myRating = null;
        base.myFeeling = null;
    }

    return base;
};

// Update Audio
const updateAudio = async (
    userId: string,
    audioId: string,
    payload: Partial<IAudio>
) => {
    const audio = await Audio.findOne({ user: userId, _id: audioId });
    if (!audio) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    // Evitar que el cliente manipule contadores/estado de bloqueo.
    // `user` va en la lista (defensa en profundidad): el controller ya lo descarta
    // del body, pero si mañana alguien llama a este service desde otra ruta, el
    // dueño del audio NO debe poder cambiarse desde un payload. Ver la nota larga
    // en audio.controller.ts (updateAudio).
    const {
        totalPlay,
        trendingScore,
        totalRating,
        ratingCount,
        isBlocked,
        moderationStatus,
        moderationReason,
        // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
        user: _user,
        ...safePayload
    } = payload as typeof payload & { user?: unknown };

    // Guard "hay algo para actualizar": el `.refine` del schema se sacó porque
    // corría ANTES de que el controller inyectara la URL del archivo subido (un
    // update sólo-con-archivo llegaba con body vacío y era rechazado). Acá el
    // payload YA trae `audio_url`/`cover_image` si se subió un archivo, así que
    // este es el punto correcto para exigir al menos un campo editable.
    if (Object.keys(safePayload).length === 0) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'At least one field must be provided for update'
        );
    }

    // Moderar los textos públicos que se estén actualizando (mismo criterio que create).
    await moderateAudioTexts(safePayload);

    // Moderar la PORTADA si se reemplaza (aunque NO cambie el audio): sin esto, un
    // update solo-de-portada metía una imagen sin moderar (bypass del control que
    // sí existe en create). Se modera acá, síncrono, antes de persistir.
    const coverChanged =
        !!payload.cover_image && payload.cover_image !== audio.cover_image;
    if (coverChanged) {
        const cover = await moderateImageUrl(
            getMediaUrl(payload.cover_image as string)
        );
        if (!cover.checked) {
            // Borrar la portada nueva (no se pudo verificar) para no dejarla
            // huérfana en S3; el audio queda con su portada previa.
            deleteFileFromS3(payload.cover_image as string);
            throw new AppError(
                httpStatus.SERVICE_UNAVAILABLE,
                'Could not verify the cover image, please try again.'
            );
        }
        if (!cover.safe) {
            // Borrar la portada nueva rechazada (recién subida en este request) y
            // rechazar el cambio; el audio queda como estaba (con su portada previa).
            deleteFileFromS3(payload.cover_image as string);
            throw new AppError(
                httpStatus.BAD_REQUEST,
                `Cover image rejected: ${cover.reason}`
            );
        }
    }

    // Re-moderación al REEMPLAZAR el archivo: si cambia `audio_url`, el audio pasa
    // a subir contenido NUEVO que nunca se moderó. Antes un audio 'ready' podía
    // reemplazarse por otro archivo y seguía visible en el feed SIN pasar de nuevo
    // por moderación (bypass). Volvemos a 'processing' (el feed filtra
    // moderationStatus='ready', así que sale de la vista) y disparamos la
    // moderación por IA de nuevo, igual que en el create.
    const audioUrlChanged =
        !!payload.audio_url && payload.audio_url !== audio.audio_url;
    const updatePayload: Partial<IAudio> = audioUrlChanged
        ? {
              ...safePayload,
              moderationStatus: ENUM_AUDIO_MODERATION_STATUS.PROCESSING,
              moderationReason: '',
          }
        : safePayload;

    const updatedAudio = await Audio.findByIdAndUpdate(audioId, updatePayload, {
        new: true,
    });

    if (payload.audio_url && audio.audio_url) {
        deleteFileFromS3(audio.audio_url);
    }
    if (payload.cover_image && audio.cover_image) {
        deleteFileFromS3(audio.cover_image);
    }

    // Fire-and-forget (mismo patrón que createAudio): la moderación pesada corre
    // en segundo plano y pasará el audio a 'ready' o 'rejected'.
    if (audioUrlChanged && payload.audio_url) {
        processAudioModeration(audioId, payload.audio_url).catch(
            () => undefined
        );
    }

    return updatedAudio;
};

// Delete Audio
const deleteAudio = async (userId: string, audioId: string) => {
    const audio = await Audio.findOne({ _id: audioId, user: userId });
    if (!audio) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    const result = await Audio.findByIdAndDelete(audioId);
    await AudioRating.deleteMany({ audio: audioId });
    await AudioBookmark.deleteMany({ audio: audioId });
    await AudioComment.deleteMany({ audio: audioId });
    if (audio.audio_url) {
        deleteFileFromS3(audio.audio_url);
    }
    if (audio.cover_image) {
        deleteFileFromS3(audio.cover_image);
    }
    return result;
};

// D.5 (Admin): listado de audios para el panel de administracion. A diferencia
// de getAllAudios, NO fuerza ningun filtro: devuelve audios de TODOS los estados
// de moderacion y tanto bloqueados como no bloqueados. El admin puede filtrar por
// query (?moderationStatus=rejected, ?isBlocked=true) via .filter().
const getAudiosForAdmin = async (query: Record<string, unknown>) => {
    const audioQuery = new QueryBuilder(
        Audio.find({})
            .populate('audioTopic')
            .populate({
                path: 'user',
                select: 'name email profile_image',
                model: 'NormalUser',
            }),
        query
    )
        .search(['title', 'description'])
        // OPT-IN capa 2: este panel admin filtra por moderationStatus/isBlocked
        // (base `Audio.find({})` SIN scope de dueño → sin riesgo de IDOR).
        .filter(['moderationStatus', 'isBlocked'])
        .sort()
        .paginate()
        .fields();

    const result = await audioQuery.modelQuery;
    const meta = await audioQuery.countTotal();

    return {
        meta,
        result: (result as unknown[]).map(withSignedMedia),
    };
};

// D.5 (Admin): bloqueo/desbloqueo reversible de un audio. Es un toggle de
// isBlocked; el audio permanece en la base de datos y solo queda oculto del feed
// (que ya filtra isBlocked:false). No borra archivos ni el registro.
const setAudioBlockedByAdmin = async (audioId: string) => {
    const audio = await Audio.findById(audioId);
    if (!audio) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    const updatedAudio = await Audio.findByIdAndUpdate(
        audioId,
        { isBlocked: !audio.isBlocked },
        { new: true }
    );
    return withSignedMedia(updatedAudio);
};

// D.5 (Admin): eliminacion definitiva de un audio por parte del administrador.
// Borra el registro, sus valoraciones, sus marcadores y los archivos de S3.
const deleteAudioByAdmin = async (audioId: string) => {
    const audio = await Audio.findById(audioId);
    if (!audio) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    const result = await Audio.findByIdAndDelete(audioId);
    await AudioRating.deleteMany({ audio: audioId });
    await AudioBookmark.deleteMany({ audio: audioId });
    await AudioComment.deleteMany({ audio: audioId });
    if (audio.audio_url) {
        deleteFileFromS3(audio.audio_url);
    }
    if (audio.cover_image) {
        deleteFileFromS3(audio.cover_image);
    }
    return result;
};

const giveRating = async (userId: string, audioId: string, rating: number) => {
    // M3 (integridad): validar que el audio exista, esté aprobado ('ready') y no
    // bloqueado ANTES de crear el AudioRating. Antes se creaba el rating y recién
    // después el $inc; si el audio no existía/estaba bloqueado, findByIdAndUpdate
    // devolvía null pero la transacción igual commiteaba → rating huérfano y
    // contadores inflables en audios no aprobados. Mismo criterio que upsertAudioFeedback.
    const audio = await assertAudioReady(audioId);
    await assertNotBlockedFromAudio(
        userId,
        (audio as unknown as { user?: { toString(): string } }).user?.toString()
    );
    // Nadie puntúa su propio audio: inflaría su reputación. La calificación es
    // la voz de los OYENTES, no del autor.
    if (
        (audio as unknown as { user?: { toString(): string } }).user?.toString() ===
        userId?.toString()
    ) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'No podés puntuar tu propio audio.'
        );
    }
    const ratingExist = await AudioRating.findOne({
        user: userId,
        audio: audioId,
    });
    if (ratingExist) {
        throw new AppError(
            httpStatus.CONFLICT,
            'You already rated that audio'
        );
    }
    const session = await mongoose.startSession();

    try {
        session.startTransaction();

        await AudioRating.create([{ user: userId, audio: audioId, rating }], {
            session,
        });

        const result = await Audio.findByIdAndUpdate(
            audioId,
            { $inc: { ratingCount: 1, totalRating: rating } },
            { new: true, session }
        );

        await session.commitTransaction();
        return result;
    } catch (error: unknown) {
        await session.abortTransaction();
        if ((error as { code?: number })?.code === 11000) {
            throw new AppError(
                httpStatus.CONFLICT,
                'You already rated that audio'
            );
        }
        throw error;
    } finally {
        session.endSession();
    }
};

// Vocabulario controlado de feeling tags (etiquetas de display, con acentos).
const getFeelingTags = (): string[] => [...FEELING_TAGS];

// Devuelve un audio existente que sea visible/valido para recibir feedback.
// Debe estar aprobado ('ready') y no bloqueado.
const assertAudioReady = async (audioId: string) => {
    if (!mongoose.Types.ObjectId.isValid(audioId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid audio id');
    }
    const audio = await Audio.findById(audioId).select(
        'moderationStatus isBlocked user'
    );
    if (!audio || (audio as unknown as { isBlocked?: boolean }).isBlocked) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    const status = (audio as unknown as { moderationStatus?: string })
        .moderationStatus;
    if (status !== ENUM_AUDIO_MODERATION_STATUS.READY) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    return audio;
};

// Bloqueo entre usuarios sobre un audio ya validado: si el usuario y el dueño del
// audio están en relación de bloqueo (en cualquier sentido), el audio "no existe"
// para él (404) — mismo criterio que getAudioById. Se aplica en las acciones sobre
// un audio AJENO (puntuar, dejar feedback): `assertAudioReady` sólo valida
// moderación, así que sin esto un usuario bloqueado podía puntuar/comentar el audio
// del que lo bloqueó con sólo tener el id.
const assertNotBlockedFromAudio = async (
    userId: string,
    ownerId?: string
): Promise<void> => {
    if (!ownerId || ownerId === userId?.toString()) return;
    const blockedIds = await getBlockedIdsFor(userId);
    if (blockedIds.includes(ownerId)) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
};

// Upsert del feedback del oyente (comentario + feeling tags). Una sola opinion
// por (audio, usuario): si ya existe, se actualiza; si no, se crea.
const upsertAudioFeedback = async (
    userId: string,
    audioId: string,
    payload: { text?: string; feelingTags?: string[] }
) => {
    const audio = await assertAudioReady(audioId);
    await assertNotBlockedFromAudio(
        userId,
        (audio as unknown as { user?: { toString(): string } }).user?.toString()
    );
    // El autor no deja feedback en su propio audio (el feedback es de los oyentes).
    if (
        (audio as unknown as { user?: { toString(): string } }).user?.toString() ===
        userId?.toString()
    ) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'No podés dejar feedback en tu propio audio.'
        );
    }

    const text = (payload.text || '').trim();

    // Validacion de subconjunto del vocabulario (ademas de la de zod) y
    // normalizacion a valores canonicos (sin duplicados).
    const rawTags = Array.isArray(payload.feelingTags)
        ? payload.feelingTags
        : [];
    const invalid = rawTags.filter((t) => !isValidFeelingTag(t));
    if (invalid.length) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            `Invalid feeling tag(s): ${invalid.join(', ')}`
        );
    }
    const feelingTags = normalizeFeelingTags(rawTags);

    if (!text && feelingTags.length === 0) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Provide at least a text comment or one feeling tag'
        );
    }

    // Moderar el comentario público (mismo criterio que las reseñas de vínculos).
    if (text) {
        const [verdict] = await isTextSafeBatch([text]);
        assertTextAllowed(verdict, 'Comment');
    }

    const result = await AudioComment.findOneAndUpdate(
        { audio: audioId, commentor: userId },
        { $set: { text, feelingTags } },
        {
            new: true,
            upsert: true,
            setDefaultsOnInsert: true,
            runValidators: true,
        }
    ).populate({
        path: 'commentor',
        select: 'name profile_image',
        model: 'NormalUser',
    });

    return result;
};

// Listado paginado (publico) del feedback de un audio + agregados: conteo de
// sensaciones sobre TODO el feedback del audio y total de comentarios.
const getAudioFeedback = async (
    audioId: string,
    query: Record<string, unknown>,
    viewerId?: string
) => {
    // Clamp con el helper común (ya testeado). Antes era `parseInt(...) || 10`
    // pelado, sin piso ni techo, y es un endpoint PÚBLICO: `?page=-3` daba un
    // `$skip` NEGATIVO que Mongo rechaza (500), `?page=1e999` daba `Infinity`
    // (500) y `?limit=999999` traía todo el feedback en una sola consulta.
    // Es la misma clase que ya se cerró en playlist y mensajes; este endpoint se
    // había quedado afuera de aquella tanda.
    const page = clampPage(query.page);
    // Tope 500 (el global del helper, igual que QueryBuilder y el listado de chats)
    // y NO 100: el consumidor de este endpoint no pagina por `page`, hace "cargar
    // más" subiendo el `limit` con `page` fijo en 1 (AudioDetail). Con un tope de
    // 100, un audio con más de 100 comentarios dejaba el botón MUERTO: el server
    // recortaba, `comments.length` se congelaba en 100, y como `totalComments` es
    // el conteo completo, la condición que muestra el botón nunca se volvía falsa
    // → cada click refetcheaba lo mismo. Antes no había techo (de ahí el DoS), así
    // que un tope bajo era una regresión funcional.
    const limit = clampLimit(query.limit, 10, 500);
    const skip = (page - 1) * limit;

    if (!mongoose.Types.ObjectId.isValid(audioId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid audio id');
    }
    // Visibilidad: el feedback público solo se sirve para audios VISIBLES (READY,
    // no bloqueados). Antes un id de audio rechazado/procesando/bloqueado seguía
    // exponiendo sus comentarios y métricas.
    await assertAudioReady(audioId);
    const audioObjectId = new mongoose.Types.ObjectId(audioId);
    // B.4: se ocultan los comentarios de usuarios bloqueados (en ambos
    // sentidos) del feedback visible para el solicitante.
    const filter: Record<string, unknown> = { audio: audioObjectId };
    const blockedObjectIds = viewerId
        ? await getBlockedObjectIdsFor(viewerId)
        : [];
    if (blockedObjectIds.length) {
        filter.commentor = { $nin: blockedObjectIds };
    }

    const [result, total, feelingCounts] = await Promise.all([
        AudioComment.find(filter)
            .populate({
                path: 'commentor',
                select: 'name profile_image',
                model: 'NormalUser',
            })
            .select('text feelingTags createdAt updatedAt commentor')
            .sort('-createdAt')
            .skip(skip)
            .limit(limit)
            .lean(),
        AudioComment.countDocuments(filter),
        getFeelingCountsForAudio(audioObjectId, undefined, blockedObjectIds),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
        meta: { page, limit, total, totalPages },
        totalComments: total,
        feelingCounts,
        result,
    };
};

// E0: registra una escucha CALIFICADA (≥30s o ≥40%), deduplicada por (audio,
// oyente, día). Hace REAL el `totalPlay` (antes nunca subía) → el "más escuchados"
// empieza a reflejar escuchas de verdad. No cuenta la del propio dueño. Idempotente:
// el 2º intento del mismo día no vuelve a sumar (índice único + rama 11000).
const recordListen = async (
    userId: string,
    audioId: string,
    payload: { secondsListened?: number; completion?: number }
) => {
    if (!mongoose.Types.ObjectId.isValid(audioId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid audio id');
    }
    if (!isQualifiedListen(payload)) {
        return { counted: false, reason: 'below-threshold' };
    }
    const audio = await Audio.findById(audioId)
        .select('user moderationStatus isBlocked')
        .lean();
    if (
        !audio ||
        audio.moderationStatus !== ENUM_AUDIO_MODERATION_STATUS.READY ||
        audio.isBlocked
    ) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    // La escucha del propio dueño no cuenta (evita auto-inflar el trending).
    if (String(audio.user) === String(userId)) {
        return { counted: false, reason: 'own-audio' };
    }
    try {
        await AudioListen.create({
            audio: audioId,
            listener: userId,
            completion: Math.max(0, Math.min(1, Number(payload.completion) || 0)),
            secondsListened: Math.max(0, Number(payload.secondsListened) || 0),
            dayBucket: dayBucketFor(new Date()),
        });
    } catch (e: any) {
        // Ya tenía una escucha calificada de este audio hoy → no re-suma.
        if (e?.code === 11000) {
            return { counted: false, reason: 'already-today' };
        }
        throw e;
    }
    await Audio.updateOne({ _id: audioId }, { $inc: { totalPlay: 1 } });
    return { counted: true };
};

const AudioService = {
    createAudio,
    processAudioModeration,
    getModerationStatus,
    getAllAudios,
    getAudioById,
    updateAudio,
    deleteAudio,
    getMyAudios,
    getAudiosByUser,
    giveRating,
    getAudiosForAdmin,
    setAudioBlockedByAdmin,
    deleteAudioByAdmin,
    getFeelingTags,
    upsertAudioFeedback,
    getAudioFeedback,
    recordListen,
};

export default AudioService;
