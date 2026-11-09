/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import mongoose from 'mongoose';
import QueryBuilder from '../../builder/QueryBuilder';
import AppError from '../../error/appError';
import { isTextSafeBatch, assertTextAllowed } from '../../helper/isTextSafe';
import { generateEmbedding } from '../../utilities/embedding';
import NormalUser from '../normalUser/normalUser.model';
import { buildLooseRegex } from '../normalUser/normalUser.services';
import { ENUM_BOND_REQUEST_STATUS } from './bondRequest.enum';
import { IBondRequest } from './bondRequest.interface';
import BondRequest from './bondRequest.model';
import BondMatch from '../bondMatch/bondMatch.model';
import BondMatchFeed from '../bondMatch/bondMatchFeed.model';
import { IMatchScoreParts } from '../bondMatch/bondMatch.interface';
import { topMatchKeys } from './matching.feed';
import {
    bondMatchFeedRowsScanned,
    bondMatchServeDuration,
    bondMatchShadowDiffTotal,
    bondMatchShadowJaccard,
    bondMatchStatusTotal,
} from '../../middlewares/metrics';
import { logger } from '../../shared/logger';
import { getBlockedIdsFor } from '../userBlock/userBlock.service';
import { BondLink } from '../bondLink/bondLink.model';
import { agendaVencida } from './matching.schedule';
import { MATCHING } from './matching.config';
import { COLOR_PALETTE, specialEntryColor, isEmptyToken } from './matching.colors';
import { clampLimit, clampPage } from '../../utilities/pagination';
import { publicMatchRequest } from './bondRequest.publicShape';
import {
    enqueueRecompute,
    invalidateAndRefresh,
    MATCH_PRIORITY_USER,
} from './matching.robot';
import sendNotification from '../../helper/sendNotification';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';
import { ENUM_SUBSCRIPTION_TYPE } from '../normalUser/normalUser.enum';
import { recalcularVinculosVivos } from '../normalUser/vinculosVivos';
import { hasBondIdentity } from './bondIdentity';
import { createBondIntegrity } from './bondIntegrity';
import Conversation from '../conversation/conversation.model';

// Mensaje único para el conflicto de vínculo duplicado. Se reutiliza tanto en
// el chequeo previo (case-insensitive + trim) como en el catch del E11000
// (red anti-carrera del índice único parcial), para que el front reciba SIEMPRE
// el mismo texto sin importar cuál de los dos niveles lo atrapó.
const DUPLICATE_BOND_MESSAGE =
    'Ya tenés un vínculo igual (mismo "ofrezco" y "busco").';

// Escapa los metacaracteres de una regex para poder comparar un string literal
// de forma case-insensitive/anclada sin que el contenido del usuario altere el
// patrón (evita inyección de regex y errores de sintaxis).
const escapeRegex = (s: string) =>
    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* QUÉ OCUPA CUPO DEL `bondLimit` — decidido por Emilio, 11/9.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * **UN VÍNCULO TIENE TRES ESTADOS: ACTIVO, PAUSADO Y ELIMINADO. NO EXISTE
 * "VÍNCULO COMPLETADO".**
 *
 * Esa es la definición de producto, y es lo que ordena todo lo demás. Concretar
 * un trueque NO retira el vínculo: si la persona no lo pausó ni lo eliminó,
 * **sigue corriendo**, porque lo más probable es que quiera repetirlo. Quien
 * ofrece clases de guitarra y consiguió una bici no dejó de ofrecer clases de
 * guitarra.
 *
 * Por eso el cupo cuenta TODO lo que la persona tenga publicado y no haya
 * borrado: activos y pausados. El ciclo de vida del trueque vive en `BondLink`
 * (Ongoing/Completed/Canceled) y es OTRA cosa — no toca al vínculo.
 *
 * ⚠️ HISTORIA DE ESTE COMENTARIO, para que no se repita. Una versión anterior
 * filtraba por `status ∈ {WAITING_FOR_LINK, ONGOING}` para que "los completados
 * no ocuparan lugar". Estaba mal dos veces:
 *   1. Era **inerte**: `BondRequest.status` no se escribe NUNCA después de crear
 *      (grepeado: no hay una sola escritura a ONGOING/COMPLETED/CANCELED en todo
 *      el árbol). Todo queda en WAITING_FOR_LINK, así que el filtro matcheaba
 *      exactamente el mismo conjunto que sin él.
 *   2. Y estaba mal **de intención**: retirar un vínculo al completar el trueque
 *      lo sacaría del pool de matcheo, que es justo lo contrario de lo que el
 *      producto quiere.
 * Se vuelve al criterio simple, que resultó ser el correcto. Liberar cupo es una
 * decisión de la persona: elimina los que ya no quiere.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ES UNA CONSTANTE Y NO DOS LITERALES A PROPÓSITO. El cupo se cuenta en DOS
 * lugares —el fast-fail barato y el autoritativo dentro de la transacción— y si
 * alguna vez difirieran, los dos chequeos darían veredictos distintos sobre la
 * misma persona: el barato la dejaría pasar y el de adentro la rechazaría, o al
 * revés. Con una sola definición eso es imposible. Esa parte sí valía la pena.
 */
export const FILTRO_CUPO_VINCULOS = {
    isDeleted: { $ne: true },
};

const createBondRequestIntoDB = async (
    userId: string,
    payload: IBondRequest
) => {
    const [user, currentBondCount] = await Promise.all([
        NormalUser.findById(userId),
        // Sólo los vínculos VIVOS ocupan cupo. Ver FILTRO_CUPO_VINCULOS arriba
        // para el criterio completo y por qué es una constante compartida.
        BondRequest.countDocuments({ user: userId, ...FILTRO_CUPO_VINCULOS }),
    ]);

    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    // Limite de vinculos. bondLimit por defecto = 25 (cuenta gratis).
    // Con `>=` una cuenta gratis crea EXACTAMENTE 25 (cuando ya tiene 25,
    // el intento 26 se bloquea). Las suscripciones pagas suben bondLimit.
    // Se devuelve 403 + code 'BOND_LIMIT_REACHED' para que el front redirija
    // de forma inequivoca a la pantalla de suscripciones.
    if (currentBondCount >= (user.bondLimit ?? 25)) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'Bond request limit reached. Please upgrade your subscription.',
            'BOND_LIMIT_REACHED'
        );
    }

    const offerTrimmed = (payload.offer ?? '').trim();
    const wantTrimmed = (payload.want ?? '').trim();
    // Both canonical and legacy identity checks finish before paid API calls.
    if (await hasBondIdentity(BondRequest, userId, offerTrimmed, wantTrimmed)) {
        throw new AppError(httpStatus.CONFLICT, DUPLICATE_BOND_MESSAGE);
    }
    // Censura de los TRES textos visibles (ofrezco/busco/descripción) en UNA sola
    // llamada batcheada: el prompt de intención se paga 1 vez en vez de 3, y son
    // 2 requests a OpenAI por vínculo (1 moderación + 1 intención) en vez de 6.
    // Capa COMPLETA (lista dura + moderación gratis + intención gpt-4o-mini, que
    // agarra frases contextuales tipo "drug dealer"). Veredicto POR CAMPO. La
    // descripción vacía devuelve safe. Bloqueante: si algo no pasa, error y NO se
    // crea nada (los embeddings ya calculados se descartan).
    const [safety, offerVector, wantVector] = await Promise.all([
        isTextSafeBatch([offerTrimmed, wantTrimmed, payload.description ?? '']),
        generateEmbedding(offerTrimmed),
        generateEmbedding(wantTrimmed),
    ]);
    const [offerCheck, wantCheck, descCheck] = safety;

    // La censura MANDA: si algo no pasa, error inmediato (embeddings descartados).
    // assertTextAllowed distingue "no permitido" (400) de "moderación caída,
    // reintentá" (503) — antes un fallo transitorio de OpenAI salía como 400
    // "no permitido" sobre contenido que podía estar perfecto.
    assertTextAllowed(offerCheck, 'Offer');
    assertTextAllowed(wantCheck, 'Want');
    assertTextAllowed(descCheck, 'Description');

    // Herencia de ubicacion (best-effort): si el payload no trae coordenadas
    // usables y el creador tiene una ubicacion guardada en su perfil, el bond
    // hereda esa ubicacion. No inventa radio ni toca la modalidad (los bonds
    // online siguen siendo globales; el matcheo ya ignora la geo en online). Si
    // el usuario no tiene ubicacion, se conserva el comportamiento actual.
    const payloadCoords = (payload as any)?.location?.coordinates as
        | number[]
        | undefined;
    const hasUsableCoords =
        Array.isArray(payloadCoords) && payloadCoords.length >= 2;
    const userCoords = (user as any)?.location?.coordinates as
        | number[]
        | undefined;
    if (
        !hasUsableCoords &&
        Array.isArray(userCoords) &&
        userCoords.length >= 2
    ) {
        (payload as any).location = {
            type: 'Point',
            coordinates: userCoords,
        };
    } else if (!hasUsableCoords) {
        // Sin coords en el payload NI heredables del perfil: NO adjuntar un
        // `location` parcial (solo `type`, sin coordinates), porque el índice
        // 2dsphere rechazaría el documento y devolvería 500. El bond se guarda
        // sin ubicación; los bonds online son globales y el matcheo geo ya tolera
        // la ausencia de coords (solo filtra por $near cuando hay location+radius).
        delete (payload as any).location;
    }

    // Cupo ATÓMICO (m1: fix de carrera del bondLimit). El chequeo de arriba
    // (~línea 56) es un fast-fail barato para no pagar OpenAI si ya estás claramente
    // al tope, pero NO es autoritativo: entre ese conteo y el create hay round-trips
    // a OpenAI, así que dos requests concurrentes podían leer el mismo conteo y ambas
    // insertar (documentos distintos → sin conflicto natural) y pasar el límite.
    // Acá, ya con censura/embeddings listos FUERA de la transacción, se re-cuenta y se
    // crea DENTRO de una transacción corta, con una escritura-guardia ($inc bondSeq)
    // sobre el doc del usuario que FUERZA un WriteConflict entre creaciones simultáneas
    // del mismo user → withTransaction reintenta la 2da, re-cuenta y ve el bono ya creado.
    let created: any;
    let countAfterCreate = 0;
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const countNow = await BondRequest.countDocuments({
                user: userId,
                // EXACTAMENTE el mismo criterio que el fast-fail, por construcción:
                // si difirieran, el chequeo barato y el autoritativo darían
                // veredictos distintos sobre la misma persona.
                ...FILTRO_CUPO_VINCULOS,
            }).session(session);
            if (countNow >= (user.bondLimit ?? 25)) {
                throw new AppError(
                    httpStatus.FORBIDDEN,
                    'Bond request limit reached. Please upgrade your subscription.',
                    'BOND_LIMIT_REACHED'
                );
            }
            // Escritura-guardia: obliga a serializar creaciones concurrentes del
            // mismo usuario (dos $inc al mismo doc → WriteConflict → reintento).
            // `hasActiveBonds: true` va en la MISMA escritura, dentro de la
            // transacción: todo vínculo nace vivo (status WAITING_FOR_LINK,
            // isPause e isLinked en false por default). Ver vinculosVivos.ts.
            const guardedUser = await NormalUser.updateOne(
                { _id: userId },
                { $inc: { bondSeq: 1 }, $set: { hasActiveBonds: true } },
                { session }
            );
            if (!guardedUser.matchedCount) throw new AppError(httpStatus.NOT_FOUND, 'User not found');
            if (await hasBondIdentity(BondRequest, userId, offerTrimmed, wantTrimmed, session)) {
                throw new AppError(httpStatus.CONFLICT, DUPLICATE_BOND_MESSAGE);
            }
            // WHITELIST (anti mass-assignment): se arman los campos EXPLÍCITOS
            // que el usuario puede fijar. Antes era `{ ...payload, ... }`, y como
            // `validateRequest` NO recorta el body, un cliente podía inyectar
            // campos internos (`status`, `isLinked`, `isPause`, `matchesComputedAt`)
            // y crear un bono con estado corrupto (ej. `isLinked:true` → invisible
            // al matcheo, o saltarse la regla de duplicado activo). Esos campos SOLO
            // los fija el sistema (o su default en el modelo). `location` ya viene
            // saneada arriba (heredada o borrada); `description`/`modality`/`radius`
            // caen a su default si vienen undefined.
            const [doc] = await BondRequest.create(
                [
                    {
                        offer: offerTrimmed,
                        want: wantTrimmed,
                        description: payload.description,
                        modality: payload.modality,
                        radius: (payload as any).radius,
                        location: (payload as any).location,
                        offerVector,
                        wantVector,
                        user: userId,
                    },
                ],
                { session }
            );
            created = doc;
            countAfterCreate = countNow + 1;
        });
    } catch (error: unknown) {
        // Red anti-carrera: un doble-submit concurrente puede pasar el chequeo
        // previo y chocar contra el índice único parcial (E11000). Se traduce a
        // un CONFLICT amigable (mismo mensaje) en vez de un 500 genérico.
        if ((error as { code?: number })?.code === 11000) {
            throw new AppError(httpStatus.CONFLICT, DUPLICATE_BOND_MESSAGE);
        }
        throw error;
    } finally {
        await session.endSession();
    }

    // Robot: precomputar los matches de este bond nuevo (no bloquea la respuesta).
    enqueueRecompute(created._id.toString(), MATCH_PRIORITY_USER);

    // Empujón a subir de plan al LLEGAR AL TOPE (25 Free / 100 Standard). NO en
    // Premium (1000: no hay plan superior). Best-effort: no debe tumbar la
    // creación del vínculo. Al clickear, el front rutea a /subscriptions.
    //
    // AVISA CADA VEZ QUE SE LLEGA AL TOPE, no una sola vez en la vida (decisión
    // de Emilio, 11/9). `subscriptionNudgeAt` marca el tope ya avisado, y el
    // borrado de un vínculo lo limpia: si la persona elimina para hacer lugar y
    // más adelante vuelve a llenar el cupo, se le avisa de nuevo.
    //
    // Antes el flag no se limpiaba nunca, así que el aviso salía UNA vez por cada
    // valor de `bondLimit` y después no volvía jamás — el único empujón de venta
    // del producto se gastaba en el primer tope y no reaparecía aunque la persona
    // siguiera chocando la pared todas las semanas.
    try {
        const limit = user.bondLimit ?? 25;
        const isTopTier =
            user.subscriptionType === ENUM_SUBSCRIPTION_TYPE.Premium;
        if (
            !isTopTier &&
            countAfterCreate >= limit &&
            user.subscriptionNudgeAt !== limit
        ) {
            await NormalUser.updateOne(
                { _id: userId },
                { $set: { subscriptionNudgeAt: limit } }
            );
            await sendNotification({
                title: 'Llegaste al tope de tu plan',
                message:
                    limit >= 100
                        ? `¡Llegaste a ${limit} vínculos! Pasá a Premium y tené hasta 1000.`
                        : `¡Llegaste a ${limit} vínculos, el tope de tu plan! Pasá a Standard y tené hasta 100.`,
                receiver: userId.toString(),
                type: ENUM_NOTIFICATION_TYPE.SUBSCRIPTION,
            });
        }
    } catch {
        /* best-effort: el empujón no debe romper la creación del vínculo */
    }

    return created;
};

const getLastBond = async (userId: string) => {
    // Los soft-deleted no cuentan como "último bono": el usuario ya los eliminó.
    return await BondRequest.findOne({ user: userId, isDeleted: { $ne: true } })
        .sort({ createdAt: -1 })
        .select('offer want location');
};

const getAllBondRequests = async (query: Record<string, unknown>) => {
    // Seguridad: NUNCA exponer los vectores de embedding ni las coordenadas
    // exactas de cada usuario. Antes se devolvía el doc completo → dump de todo
    // el dataset de matcheo (ofertas, ubicaciones precisas y embeddings). Se
    // ocultan igual que en myBondRequests. (De paso: search usaba campos
    // inexistentes 'give'/'get' → se corrige a 'offer'/'want'.)
    const resultQuery = new QueryBuilder(
        BondRequest.find({ isDeleted: { $ne: true } }).select(
            '-offerVector -wantVector -location'
        ),
        query
    )
        .search(['offer', 'want'])
        .fields()
        .filter()
        .paginate()
        .sort();

    const result = await resultQuery.modelQuery;
    const meta = await resultQuery.countTotal();

    return {
        meta,
        result,
    };
};
const myBondRequests = async (
    userId: string,
    query: Record<string, unknown>
) => {
    const resultQuery = new QueryBuilder(
        // `isDeleted` es redundante con `isLinked:false` (el soft-delete marca los
        // dos), pero esta es LA lista de bonos propios del usuario: si alguna vez
        // se cambia cómo se marca un borrado, acá no debe reaparecer igual.
        BondRequest.find({
            user: userId,
            isLinked: false,
            isDeleted: { $ne: true },
        }).select('-offerVector -wantVector'),
        query
    )
        .search(['offer', 'want', 'location'])
        .fields()
        .filter()
        .paginate()
        .sort();

    const result = await resultQuery.modelQuery;
    const meta = await resultQuery.countTotal();

    return {
        meta,
        result,
    };
};

const getSingleBondRequest = async (id: string, viewerId?: string) => {
    // Seguridad: no exponer vectores de embedding ni coordenadas exactas (mismo
    // criterio que getAllBondRequests / myBondRequests).
    const bondRequest = await BondRequest.findById(id).select(
        '-offerVector -wantVector -location'
    );
    if (!bondRequest)
        throw new AppError(httpStatus.NOT_FOUND, 'BondRequest not found');
    // Visibilidad: por id solo se ve un bond ACTIVO y disponible (navegable, no
    // pausado, no linkeado) o el propio dueño el suyo. Antes devolvía cualquier
    // bond (pausado/linkeado/histórico/ajeno) por id.
    const isOwner =
        !!viewerId && bondRequest.user?.toString() === viewerId.toString();
    const isVisible =
        !bondRequest.isPause &&
        bondRequest.isLinked !== true &&
        (bondRequest.status === ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK ||
            bondRequest.status === ENUM_BOND_REQUEST_STATUS.ONGOING);
    if (!isOwner && !isVisible) {
        throw new AppError(httpStatus.NOT_FOUND, 'BondRequest not found');
    }
    return bondRequest;
};

const updateBondRequestIntoDB = async (
    userId: string,
    id: string,
    payload: Partial<IBondRequest>
) => {
    const bondRequest = await BondRequest.findOne({ _id: id, user: userId });
    if (!bondRequest)
        throw new AppError(httpStatus.NOT_FOUND, 'BondRequest not found');

    // Editar el CONTENIDO de un vínculo está prohibido por producto (crashea y se
    // descartó). Lo único que se permite por esta vía es PAUSAR/REANUDAR, que es
    // un estado válido del vínculo y el único interruptor que lo saca del pool.
    //
    // El bloqueo es por CAMPO y no cortando la ruta: cuando se cortó la ruta
    // entera con un 403, se rompió el botón de pausa del front, que pega acá.
    // Nada de esto reemplaza al allowlist de más abajo (que sigue siendo la
    // defensa contra mass-assignment); esto es la regla de producto.
    const CAMPOS_DE_CONTENIDO = [
        'offer',
        'want',
        'description',
        'location',
        'radius',
        'modality',
    ];
    const intentaEditarContenido = CAMPOS_DE_CONTENIDO.some(
        (k) => (payload as Record<string, unknown>)[k] !== undefined
    );
    if (intentaEditarContenido) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'La edición de vínculos está deshabilitada.'
        );
    }

    // Censura batcheada (misma optimización que el create): los campos que vienen
    // en el payload (ofrezco/busco/descripción) se chequean en UNA sola llamada,
    // no en tres. Capa COMPLETA, veredicto POR CAMPO. Editar SOLO la descripción
    // también pasa por censura ANTES de guardar (antes se colaba sin filtro).
    const toCheck: { label: string; text: string }[] = [];
    if (payload.offer) toCheck.push({ label: 'Offer', text: payload.offer });
    if (payload.want) toCheck.push({ label: 'Want', text: payload.want });
    if (payload.description)
        toCheck.push({ label: 'Description', text: payload.description });
    if (toCheck.length) {
        const verdicts = await isTextSafeBatch(toCheck.map((c) => c.text));
        toCheck.forEach((c, i) => {
            assertTextAllowed(verdicts[i], c.label);
        });
    }

    // MASS-ASSIGNMENT: solo se aceptan los campos editables por el usuario. Antes se
    // hacía findByIdAndUpdate(...payload) y, como validateRequest NO recorta el body,
    // un usuario podía inyectar status/isLinked/offerVector/wantVector/user/
    // matchesComputedAt → corromper estado o ENVENENAR el matcheo con vectores
    // fabricados. Allowlist explícito; los embeddings se recomputan acá desde el
    // texto, nunca vienen del cliente.
    const ALLOWED_UPDATE_FIELDS = [
        'offer',
        'want',
        'description',
        'location',
        'radius',
        'modality',
        'isPause',
    ];
    const safePayload: Partial<IBondRequest> = {};
    for (const k of ALLOWED_UPDATE_FIELDS) {
        if ((payload as any)[k] !== undefined) {
            (safePayload as any)[k] = (payload as any)[k];
        }
    }

    // Duplicado normalizado (mismo criterio que el create): editar un vínculo no
    // debe dejarlo igual —salvo mayúsculas/espacios— a otro vínculo activo del mismo
    // usuario. El create lo chequea; el update lo omitía, y el índice único es
    // exact-string (no tolera case/espacios). Se compara el resultado FINAL (campo
    // nuevo, o el existente si no se edita), excluyendo el propio vínculo.
    if (safePayload.offer !== undefined || safePayload.want !== undefined) {
        const finalOffer = (safePayload.offer ?? bondRequest.offer ?? '').trim();
        const finalWant = (safePayload.want ?? bondRequest.want ?? '').trim();
        const dup = await BondRequest.findOne({
            _id: { $ne: id },
            user: userId,
            status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
            isLinked: { $ne: true },
            offer: new RegExp(`^${escapeRegex(finalOffer)}$`, 'i'),
            want: new RegExp(`^${escapeRegex(finalWant)}$`, 'i'),
        })
            .select('_id')
            .lean();
        if (dup) {
            throw new AppError(httpStatus.CONFLICT, DUPLICATE_BOND_MESSAGE);
        }
    }

    let updated;
    if (safePayload.offer && safePayload.want) {
        const [offerVector, wantVector] = await Promise.all([
            generateEmbedding(safePayload.offer),
            generateEmbedding(safePayload.want),
        ]);

        updated = await BondRequest.findByIdAndUpdate(
            id,
            { ...safePayload, offerVector, wantVector },
            { new: true }
        );
    } else if (safePayload.offer) {
        const offerVector = await generateEmbedding(safePayload.offer);
        updated = await BondRequest.findByIdAndUpdate(
            id,
            { ...safePayload, offerVector },
            { new: true }
        );
    } else if (safePayload.want) {
        const wantVector = await generateEmbedding(safePayload.want);
        updated = await BondRequest.findByIdAndUpdate(
            id,
            { ...safePayload, wantVector },
            { new: true }
        );
    } else {
        updated = await BondRequest.findByIdAndUpdate(id, safePayload, {
            new: true,
        });
    }

    // Robot: la oferta/deseo/estado pudo cambiar -> invalidar cache y recomputar.
    // `active` = sigue disponible para matchear (no pausado, esperando link).
    const active =
        !!updated &&
        !updated.isPause &&
        updated.status === ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK;
    invalidateAndRefresh(id, active).catch(() => undefined);

    // De los campos editables, sólo `isPause` cambia si el vínculo está vivo
    // (`status` e `isLinked` no están en ALLOWED_UPDATE_FIELDS).
    if (safePayload.isPause !== undefined) {
        await recalcularVinculosVivos(userId);
    }

    return updated;
};

const deleteBondRequestFromDB = async (userId: string, id: string) => {
    // The shared transaction guard prevents a link from referencing a concurrently deleted bond.
    // Completed history is soft-deleted; canceled-only/unreferenced bonds retain hard-delete behavior.
    const result = await createBondIntegrity({
        bonds: BondRequest, links: BondLink, conversations: Conversation,
        startSession: () => mongoose.startSession(),
    }).deleteBond(userId, id);

    // REARMA EL EMPUJÓN DE SUSCRIPCIÓN (decisión de Emilio, 11/9).
    //
    // Borrar un vínculo es la única forma de que el cupo BAJE. Si no se limpiara
    // el flag, la persona que llena el cupo, borra dos y vuelve a llenarlo NO
    // recibiría el aviso la segunda vez — ni ninguna otra vez en su vida, porque
    // `subscriptionNudgeAt` sigue igual al `bondLimit` para siempre.
    //
    // Con el `$unset`, el aviso vuelve a estar disponible: se avisa cada vez que
    // se llega al tope, que es lo que corresponde. Best-effort a propósito: que
    // no se pueda rearmar el empujón no puede hacer fallar un borrado.
    NormalUser.updateOne(
        { _id: userId },
        { $unset: { subscriptionNudgeAt: '' } }
    ).catch(() => undefined);

    // Robot: limpiar la cache de este bond y refrescar a los afectados.
    invalidateAndRefresh(id, false).catch(() => undefined);

    // Baja lógica o borrado: puede haber sido su último vínculo vivo.
    await recalcularVinculosVivos(userId);

    return result;
};

export const cosineSimilarity = (a: number[], b: number[]): number => {
    if (!Array.isArray(a) || !Array.isArray(b)) return 0;
    const minLen = Math.min(a.length, b.length);
    let dot = 0,
        magA = 0,
        magB = 0;
    for (let i = 0; i < minLen; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    magA = Math.sqrt(magA);
    magB = Math.sqrt(magB);
    if (!magA || !magB) return 0;
    return dot / (magA * magB);
};

export const normalizeText = (s?: string) =>
    (s || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

export const tokenOverlapRatio = (a?: string, b?: string): number => {
    const A = normalizeText(a).split(' ').filter(Boolean);
    const B = normalizeText(b).split(' ').filter(Boolean);
    if (!A.length || !B.length) return 0;
    const setB = new Set(B);
    const overlap = A.filter((t) => setB.has(t)).length;
    return overlap / Math.min(A.length, B.length);
};

export const calculateMatchScore = (
    wantVec: number[] = [],
    offerVec: number[] = []
): number => {
    const sim = cosineSimilarity(wantVec, offerVec);

    return sim;
};


type MatchType = 'entry' | 'surprise' | 'empty';

/** Comparación shadow feed-vs-legacy. Se muestrea y corre después de servir:
 *  el camino elegido nunca espera por ella. Mide solapamiento del top-N. */
const shadowCompareMatches = async (
    bondRequestId: string,
    served: any[],
    servedMode: 'feed' | 'legacy'
): Promise<void> => {
    const other =
        servedMode === 'feed'
            ? await BondMatch.find({ bonds: bondRequestId })
                  .select('bonds score')
                  .sort({ size: 1, score: -1, _id: 1 })
                  .lean()
            : await BondMatchFeed.find({ bond: bondRequestId })
                  .sort({ score: -1, _id: 1 })
                  .limit(MATCHING.feedScanLimit)
                  .lean();

    const servedSet = new Set(topMatchKeys(served, MATCHING.maxResults));
    const otherSet = new Set(topMatchKeys(other as any[], MATCHING.maxResults));
    let inter = 0;
    for (const k of servedSet) if (otherSet.has(k)) inter++;
    const union = servedSet.size + otherSet.size - inter;
    const jaccard = union === 0 ? 1 : inter / union;

    bondMatchShadowJaccard.observe(jaccard);
    if (jaccard < 0.99) {
        bondMatchShadowDiffTotal.inc({ result: 'diff' });
        logger.warn(
            `[matching][shadow] ${bondRequestId} mode=${servedMode} jaccard=${jaccard.toFixed(3)} ` +
                `onlyServed=${[...servedSet].filter((k) => !otherSet.has(k)).length} ` +
                `onlyOther=${[...otherSet].filter((k) => !servedSet.has(k)).length}`
        );
    } else {
        bondMatchShadowDiffTotal.inc({ result: 'same' });
    }
};

export const getMatchingBondRequest = async (
    userId: string,
    bondRequestId: string,
    query: Record<string, unknown>
) => {
    // F3.6 (defensivo): clamp de page/limit. Un `?page=-5` daba startIndex negativo
    // → `matches.slice(negativo, ...)` cuenta desde el FINAL y devuelve una página
    // basura. page>=1; limit acotado a [1,500] (mismo tope global que el paginador).
    // Se unifica con el helper común (ya testeado) en vez de repetir el clamp a
    // mano: la versión anterior dejaba pasar `?page=1e999` (Math.max(1, Infinity)
    // sigue siendo Infinity). Acá NO causaba un 500 —la paginación es en memoria
    // con `.slice()`, que con Infinity devuelve vacío— pero tener dos
    // implementaciones distintas del mismo clamp es lo que produce el próximo bug.
    // NO toca nada del matcheo: sólo acota page/limit del serving.
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit, 10, 500);

    const normalize = (s?: string) => normalizeText(s);

    const startRequest = await BondRequest.findOne({
        _id: bondRequestId,
        user: userId,
        status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
        // Un bono soft-deleted NO puede volver acá. El soft-delete lo marca con
        // `isPause: true`, y unas líneas más abajo esta función DESPAUSA el bono
        // al buscar coincidencias ("si el dueño busca, es señal de interés"). Sin
        // este filtro, entrar a la pantalla de matches de un bono ya eliminado lo
        // resucitaba parcialmente: volvía a quedar despausado.
        isDeleted: { $ne: true },
    })
        .select(
            'matchesComputedAt matchesNextAt lastServedAt isPause'
        )
        .lean();

    if (!startRequest) throw new AppError(404, 'Bond request not found');

    // Reactivar al buscar: si el dueño aprieta "buscar coincidencia" sobre un
    // vínculo pausado, es señal de interés → lo reactivamos (vuelve al pool) y
    // avisamos al front (reactivated:true) para mostrar el cartel. La pausa es el
    // único interruptor que saca del pool; buscar coincidencias lo re-enciende.
    let reactivated = false;
    if ((startRequest as any).isPause) {
        // Además de despausar, limpiamos matchesComputedAt: al pausar, su caché
        // pudo quedar vacía con timestamp reciente, y sin esto daría 'ready 0'
        // falso. Con matchesComputedAt ausente, el flujo de abajo devuelve
        // 'computing' y encola el recomputo.
        //
        // Y SE VENCE LA AGENDA, que es la mitad que faltaba (panel del 11/9).
        // Desde el TTL adaptativo, limpiar `matchesComputedAt` YA NO HACE
        // ELEGIBLE A NADA: el sweep mira `matchesNextAt`. Un vínculo frío
        // despausado acá quedaba con la agenda a 24 horas vista; si además el
        // encolado de prioridad de usuario de más abajo fallaba (Redis con hipo:
        // el `.catch` lo traga y la API no computa inline a propósito), el vínculo
        // quedaba ACTIVO, SIN CACHÉ y SIN AGENDA VENCIDA — o sea el front
        // sondeando cada 3 segundos durante un día entero.
        //
        // `invalidateAndRefresh` ya vencía los dos campos juntos; este era el otro
        // lugar del repo donde se ensucia la caché a mano y había quedado con la
        // mitad vieja.
        await BondRequest.updateOne(
            { _id: bondRequestId, user: userId },
            {
                $set: { isPause: false, matchesNextAt: agendaVencida() },
                $unset: { matchesComputedAt: '' },
            }
        );
        (startRequest as any).isPause = false;
        (startRequest as any).matchesComputedAt = undefined;
        (startRequest as any).matchesNextAt = agendaVencida();
        reactivated = true;
        // Despausado: el dueño vuelve a tener un vínculo vivo.
        await recalcularVinculosVivos(userId);
    }

    // Matches precomputados. La petición es una simple LECTURA: el robot
    // (BullMQ / inline) mantiene la cache caliente en segundo plano.
    //
    // MODO FEED (MATCH_FEED_READ): lee las N mejores filas del feed DEL BOND,
    // con el índice { bond: 1, score: -1 }. Es un read acotado: ~400 filas
    // (~150 KB) en vez del superset de { bonds: id } (miles de docs / ~4 MB).
    // El resto del pipeline (dedup, bloqueos, fantasmas, ranking, paginado) es
    // EXACTAMENTE el mismo. MODO LEGACY: se conserva para rollback.
    const lecturaInicio = Date.now();
    let cached: any[];
    if (MATCHING.feedRead) {
        cached = await BondMatchFeed.find({ bond: bondRequestId })
            .sort({ score: -1, _id: 1 })
            .limit(MATCHING.feedScanLimit)
            // Sin esto el driver trae 101 docs y pide un getMore: con Atlas
            // remoto son ~400 ms extra de RTT por request.
            .batchSize(MATCHING.feedScanLimit)
            .lean();
        bondMatchFeedRowsScanned.observe(cached.length);
    } else {
        cached = await BondMatch.find({ bonds: bondRequestId })
            .sort({ size: 1, score: -1, _id: 1 })
            .lean();
    }
    bondMatchServeDuration.observe(
        { mode: MATCHING.feedRead ? 'feed' : 'legacy' },
        (Date.now() - lecturaInicio) / 1000
    );
    const ttlMs = MATCHING.cacheTtlMinutes * 60 * 1000;

    // SEÑAL DE INTERÉS REAL (escala). Que el dueño abra esta pantalla es lo único
    // que dice "este vínculo me importa", y es lo que lo mantiene CALIENTE (TTL de
    // 1 h en vez de 24 h). Ver matching.schedule.ts.
    //
    // ⚠️ DOS GUARDAS QUE NO SON OPCIONALES (las dos salieron del panel del 11/9):
    //
    // 1. `timestamps: false`. SIN ESTO, ESTA LÍNEA TOCA EL MOTOR DE MATCHEO.
    //    El schema tiene `timestamps: true` y mongoose engancha un pre-hook en
    //    `updateOne` (verificado en node_modules), así que la escritura también
    //    pisaría `updatedAt`. Y `updatedAt` NO es decorativo: es la entrada de
    //    `freshnessFactor` (matching.compute.ts:242 → matching.scoring.ts:65),
    //    que pesa 0.1 del puntaje final. O sea que, sin la guarda, **tener tu
    //    pantalla de coincidencias abierta te subía el ranking en la lista de
    //    todos los demás** — y el front sondea cada 3 segundos. Autobombeo puro,
    //    introducido de rebote por una señal de escala.
    //
    // 2. Estrangulador. Sin él esto escribía en CADA sondeo de 3 s y en cada
    //    clic de paginado, sobre una colección con 5 índices y documentos de
    //    ~40 KB (los dos vectores de 1536 dims). Para lo que la señal necesita
    //    —saber si alguien miró en las últimas 72 h— un sello cada 5 minutos da
    //    exactamente la misma respuesta por tres órdenes de magnitud menos
    //    escritura.
    //
    // Fire-and-forget: si falla no pasa nada, el vínculo simplemente se enfría.
    // Va ANTES del early-return para que también cuente cuando todavía no hay
    // nada que mostrar, que es justo cuando más conviene que esté caliente.
    const servidoAntes = (startRequest as any)?.lastServedAt;
    const refrescoServidoMs =
        Math.max(Number(process.env.MATCH_SERVED_STAMP_MINUTES) || 5, 1) *
        60 *
        1000;
    if (
        !servidoAntes ||
        Date.now() - new Date(servidoAntes).getTime() > refrescoServidoMs
    ) {
        BondRequest.updateOne(
            { _id: bondRequestId },
            { $set: { lastServedAt: new Date() } },
            { timestamps: false }
        ).catch(() => undefined);
    }

    const edadCacheMs =
        cached.length > 0 && cached[0].computedAt
            ? Date.now() - new Date(cached[0].computedAt).getTime()
            : Infinity;

    // ── DOS TTL DISTINTOS, Y LA DIFERENCIA IMPORTA ──────────────────────────
    //
    // `ttlMs` (60 min) = "¿conviene REFRESCAR esto?"
    // `ttlServibleMs`  = "¿todavía vale la pena MOSTRARLO?"
    //
    // Antes eran el mismo número, y eso producía un bug que el TTL adaptativo
    // habría multiplicado por 24: con la caché a 61 minutos, esta función
    // devolvía `computing` + data VACÍA, o sea que el usuario veía un spinner y
    // CERO coincidencias aunque tuviéramos sus matches guardados y perfectamente
    // buenos. Con el sweep cubriendo 2.400 vínculos/hora eso ya pasaba seguido;
    // con vínculos fríos refrescándose cada 24 h, el usuario habría visto el
    // spinner CASI SIEMPRE.
    //
    // Ahora: si hay caché servible, SE SIRVE, y si además está vencida se encola
    // el refresco por detrás con prioridad de usuario. Nadie mira un spinner
    // teniendo datos. Es estrictamente mejor que antes, no sólo compatible.
    const ttlServibleMs = MATCHING.serveTtlMinutes * 60 * 1000;
    const hayCacheServible = edadCacheMs < ttlServibleMs;
    const cacheVencida = edadCacheMs >= ttlMs;

    if (!hayCacheServible) {
        // Sin nada que mostrar. Se conserva EXACTAMENTE la lógica de antes:
        //   - computado hace poco y sin caché => se computó y dio CERO matches
        //     => 'ready' + data vacía (el front deja de sondear).
        //   - si no => se encola y se devuelve 'computing' al instante.
        const computedAt = (startRequest as any).matchesComputedAt;
        const recentlyComputed =
            !!computedAt &&
            Date.now() - new Date(computedAt).getTime() < ttlMs;

        if (!recentlyComputed) {
            // Dispara el cómputo en segundo plano (fire-and-forget).
            enqueueRecompute(bondRequestId, MATCH_PRIORITY_USER);
        }

        bondMatchStatusTotal.inc({
            status: recentlyComputed ? 'ready' : 'computing',
        });

        return {
            // 'ready' = cómputo terminado (aquí, con cero matches);
            // 'computing' = encolado, el front debe reintentar.
            status: recentlyComputed ? 'ready' : 'computing',
            reactivated,
            total: 0,
            page,
            limit,
            data: [] as any[],
        };
    }

    // Hay caché servible. Si además está vencida, se refresca POR DETRÁS con
    // prioridad de usuario mientras se sirve lo que ya tenemos. La deduplicación
    // por `jobId` de BullMQ hace que recargar la pantalla no apile jobs.
    if (cacheVencida) {
        enqueueRecompute(bondRequestId, MATCH_PRIORITY_USER);
    }

    const records: any[] = cached;

    const matches: {
        ids: string[];
        users: string[];
        score: number;
        type: MatchType;
        parts: IMatchScoreParts;
    }[] = records.map((r: any) => ({
        ids: (r.bonds ?? r.ids).map((id: any) => id.toString()),
        // Dueños que YA guarda cada BondMatch → filtrar bloqueados sin poblar.
        users: (r.users ?? []).map((id: any) => id.toString()),
        score: r.score,
        type: r.type as MatchType,
        // `parts` viene tanto de la cache (BondMatch.parts) como del cómputo al
        // vuelo (MatchRecord.parts). Se conserva para exponer el desglose del
        // puntaje ("why you matched"). Fallback defensivo si faltara.
        parts: (r.parts ?? {
            sem: 0,
            rep: 0,
            prox: 0,
            fresh: 0,
        }) as IMatchScoreParts,
    }));

    // F3.3 — Backfill defensivo de dueños en docs LEGACY de BondMatch. Los docs
    // viejos pueden traer `users` vacío (denormalización previa); sin dueños, el
    // filtro de bloqueo de más abajo (`m.users.some(...)`) da SIEMPRE false y un
    // usuario bloqueado se colaría en los matches. Si algún match viene sin
    // dueños, los poblamos desde la DB con UNA query liviana (solo `_id user`, sin
    // poblar vínculos), reusando el patrón del filtro fantasma. `BondRequest.user`
    // y `BondMatch.users` refieren ambos a `NormalUser`: el id backfilleado cae en
    // el MISMO espacio que `p2pBlockedIds` y el filtro admin, idéntico a lo que el
    // cómputo persiste. Costo: CERO en el caso común (los BondMatch nuevos ya traen
    // `users`); solo corre si hay docs legacy.
    const matchesSinDuenos = matches.filter((m) => m.users.length === 0);
    if (matchesSinDuenos.length > 0) {
        const bondIdsSinDueno = [
            ...new Set(matchesSinDuenos.flatMap((m) => m.ids)),
        ];
        const duenoDocs = await BondRequest.find({
            _id: { $in: bondIdsSinDueno },
        })
            .select('_id user')
            .lean();
        const duenoPorBond = new Map<string, string | undefined>(
            duenoDocs.map(
                (d: any): [string, string | undefined] => [
                    d._id.toString(),
                    d.user?.toString(),
                ]
            )
        );
        for (const m of matchesSinDuenos) {
            m.users = [
                ...new Set(
                    m.ids
                        .map((id) => duenoPorBond.get(id))
                        .filter((u): u is string => !!u)
                ),
            ];
        }
    }

    // Bloqueo (B.4 + C.5): se filtra el SET COMPLETO antes de paginar (para que el
    // total y las páginas sean correctos), pero usando los dueños que YA guarda
    // cada BondMatch (`users`) → NO hace falta poblar los vínculos para filtrar.
    // PERF: antes se poblaban TODOS los vínculos de TODOS los matches en CADA
    // request (y en cada cambio de página); ese era el costo que hacía lento el
    // paginado. Ahora se puebla SOLO la página (más abajo, tras el slice).
    //  - P2P (B.4): usuarios bloqueados por/hacia el que consulta (1 query).
    //  - Admin (C.5): usuarios con User.isBlocked === true (1 query liviana sobre
    //    los dueños involucrados, sin traer los vínculos).
    const p2pBlockedIds = new Set(await getBlockedIdsFor(userId));
    const allOwners = [...new Set(matches.flatMap((m) => m.users))];
    const adminBlockedOwners = new Set<string>();
    if (allOwners.length > 0) {
        const owners = await NormalUser.find({ _id: { $in: allOwners } })
            .select('user')
            .populate({ path: 'user', select: 'isBlocked' })
            .lean();
        for (const o of owners as any[]) {
            if (o?.user?.isBlocked === true) {
                adminBlockedOwners.add(o._id.toString());
            }
        }
    }

    if (p2pBlockedIds.size > 0 || adminBlockedOwners.size > 0) {
        for (let i = matches.length - 1; i >= 0; i--) {
            const blocked = matches[i].users.some(
                (u) => p2pBlockedIds.has(u) || adminBlockedOwners.has(u)
            );
            if (blocked) matches.splice(i, 1);
        }
    }

    // Matches FANTASMA / NO DISPONIBLES: la cache (BondMatch) puede tener tratos
    // cuyos vínculos ya no están vivos — el otro dueño borró su vínculo (queda un
    // id colgado → antes se poblaba a `null` y la UI mostraba un match vacío) o lo
    // pausó (antes se poblaba igual y aparecía como disponible sin estarlo). Un
    // match solo vale si TODOS los OTROS participantes (no el propio sourceBond)
    // siguen EXISTIENDO y ACTIVOS (status navegable + no pausado). Se filtra ANTES
    // de contar/paginar, así el `total` y lo mostrado quedan coherentes. Costo: una
    // sola query liviana que trae solo `_id` (índice), no pobla nada.
    const otherIds = [
        ...new Set(
            matches.flatMap((m) => m.ids).filter((id) => id !== bondRequestId)
        ),
    ];
    if (otherIds.length > 0) {
        const liveDocs = await BondRequest.find({
            _id: { $in: otherIds },
            status: {
                $in: [
                    ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
                    ENUM_BOND_REQUEST_STATUS.ONGOING,
                ],
            },
            isPause: false,
        })
            .select('_id')
            .lean();
        const liveSet = new Set(liveDocs.map((d) => d._id.toString()));
        for (let i = matches.length - 1; i >= 0; i--) {
            const allLive = matches[i].ids
                .filter((id) => id !== bondRequestId)
                .every((id) => liveSet.has(id));
            if (!allLive) matches.splice(i, 1);
        }
    }

    // Dedup defensivo por CONJUNTO de participantes (mismos bonds, cualquier
    // orden): la cache previa puede tener el mismo grupo dos veces (un ciclo y su
    // reverso). Se colapsa al de MAYOR score, así el usuario nunca ve el mismo
    // match repetido y el `total` refleja el conteo real. (El cómputo ya
    // deduplica en origen; esto cubre lo ya persistido hasta el próximo recómputo.)
    const bestBySet = new Map<string, (typeof matches)[number]>();
    for (const m of matches) {
        const key = [...m.ids].sort().join('|');
        const prev = bestBySet.get(key);
        if (!prev || m.score > prev.score) bestBySet.set(key, m);
    }
    if (bestBySet.size !== matches.length) {
        const deduped = [...bestBySet.values()];
        matches.length = 0;
        matches.push(...deduped);
    }

    //  ORDEN. NUEVO (default): por SCORE, sin dictadores. `pairBias` es una
    //  preferencia SUAVE por cadenas cortas, aplicada como resta al ranking
    //  (size 2 = 0; 3 = -pairBias; 4 = -2·pairBias; ...), NO un override: un ciclo
    //  bastante mejor por cálculo igual le gana a un par. Se aplica acá (serving),
    //  así ajustar `pairBias` NO requiere recomputar — basta reiniciar la API.
    //  LEGACY (interruptor): vuelve al orden duro size→type→score.
    const typePriority: Record<MatchType, number> = {
        entry: 1,
        surprise: 2,
        empty: 3,
    };
    const legacy = MATCHING.legacyRanking;
    const rankScore = (m: (typeof matches)[number]) =>
        m.score - (legacy ? 0 : MATCHING.pairBias * (m.ids.length - 2));

    matches.sort((a, b) => {
        if (legacy) {
            if (a.ids.length !== b.ids.length) {
                return a.ids.length - b.ids.length;
            }
            if (a.type !== b.type) {
                return typePriority[a.type] - typePriority[b.type];
            }
        }
        const ra = rankScore(a);
        const rb = rankScore(b);
        if (ra !== rb) {
            return rb - ra;
        }
        // Desempate ESTABLE por la combinación de bonds (única por match): sin
        // esto, empates exactos de score podían reordenarse entre páginas →
        // un match se duplicaba en una página y faltaba en otra.
        return a.ids.join('-').localeCompare(b.ids.join('-'));
    });

    // TOPE DE SERVICIO (pedido de Emilio): el matcheo es un RANKING acotado, no un
    // catálogo. Servir por `bonds` junta las cadenas de MUCHOS sourceBonds (el bond
    // participa en cadenas que originaron otros) → el conjunto podía tener cientos
    // de cadenas y el front paginaba 40+ páginas. Nos quedamos con las MEJORES
    // `maxResults` (100) que superen `minServeScore` (0.4) sobre el score FINAL.
    // `matches` ya viene ordenado por ranking desc, así que filtrar+cortar preserva
    // el orden. El `total` pasa a ser el del conjunto TOPEADO (coherente con las
    // páginas: como mucho 100 → nunca más de ceil(100/limit) páginas).
    const served = matches
        .filter((m) => m.score >= MATCHING.minServeScore)
        .slice(0, MATCHING.maxResults);

    const startIndex = (page - 1) * limit;
    const pageMatches = served.slice(startIndex, startIndex + limit);

    // ROTACIÓN (re-aplicada 3/8, del 30/7): ahora que servimos por `bonds`, un
    // match puede venir guardado bajo el sourceBond de la CONTRAPARTE, así que el
    // bond que estás mirando puede caer en cualquier posición de la cadena. Se
    // rota cíclicamente para que TU bond quede SIEMPRE primero. Es una rotación
    // (no un reordenamiento): preserva el orden del ciclo → los prev/next y por
    // ende los colores del intercambio siguen correctos. `users` se rota igual
    // para no desalinearlo de `ids`.
    for (const m of pageMatches) {
        const pos = m.ids.indexOf(bondRequestId);
        if (pos > 0) {
            m.ids = [...m.ids.slice(pos), ...m.ids.slice(0, pos)];
            if (Array.isArray(m.users) && m.users.length === m.ids.length) {
                m.users = [...m.users.slice(pos), ...m.users.slice(0, pos)];
            }
        }
    }

    // PERF (arreglo del paginado lento): poblar SOLO los vínculos de ESTA página,
    // no todo el conjunto. Así el costo de cada página deja de escalar con el
    // total de matches y pasa a ser ~constante (los ~pocos de la página).
    const pageIds = [...new Set(pageMatches.flatMap((m) => m.ids))];
    const populated = await BondRequest.find({ _id: { $in: pageIds } })
        // WHITELIST en la consulta (defensa en profundidad): traemos SOLO offer,
        // want y user. Antes era `.select('-wantVector -offerVector')`, que NO
        // excluía `location` → el `{...request}` de abajo filtraba las coordenadas
        // GPS exactas de cada contraparte. Ahora la ubicación ni se lee de la DB, y
        // además la salida pasa por `publicMatchRequest` (whitelist de campos).
        .select('offer want user')
        // `reputation` va en el select del USER: la tarjeta muestra su estrella, y
        // sin este campo el front leía uno inexistente (`avgRating`) y mostraba
        // SIEMPRE "⭐ 0", incluso para gente con reseñas reales.
        .populate({ path: 'user', select: 'name profile_image reputation' })
        .lean();
    const populatedMap = new Map(
        populated.map((r) => [r._id.toString(), r])
    );

    //  ASSIGN COLORS TO EACH MATCH (FIXED VERSION)
    const result = pageMatches.map((m) => {
        const cycleSize = m.ids.length;

        const colors = COLOR_PALETTE;

        const matchRequestsWithColors = m.ids.map((id, index) => {
            const request = populatedMap.get(id);
            if (!request) return null;

            const currentWant = normalize(request.want);
            const currentOffer = normalize(request.offer);

            const prevIndex = (index - 1 + cycleSize) % cycleSize;
            const nextIndex = (index + 1) % cycleSize;
            const prevWant = normalize(populatedMap.get(m.ids[prevIndex])?.want);
            const nextOffer = normalize(
                populatedMap.get(m.ids[nextIndex])?.offer
            );

            // REGLA DURA del color. Cada caja pertenece a UN intercambio (par):
            //   - la OFERTA de i satisface el DESEO de i-1 → par (prevWant, currentOffer)
            //   - el DESEO de i lo satisface la OFERTA de i+1 → par (currentWant, nextOffer)
            // Color especial de cada caja (specialEntryColor), POR-PAR (mismo color
            // en las dos puntas; el vacío solo aparea con vacío o sorpresa):
            //   - vacío ↔ sorpresa → violeta (comodín contra comodín).
            //   - vacío ↔ vacío → coral (regalo mutuo).
            //   - sorpresa ↔ sorpresa → fucsia (doble sorpresa).
            //   - sorpresa ↔ concreto / concreto ↔ concreto → pastel de paleta.
            // Índice con módulo: maxCycleSize puede llegar a 6 y la paleta tiene 5
            // colores → sin módulo, colors[5] sería undefined. Módulo = mismo
            // comportamiento que el front (MatchGroup) y pares concretos siempre coloreados.
            const wantColor =
                specialEntryColor(currentWant, nextOffer) ??
                colors[index % colors.length];
            const offerColor =
                specialEntryColor(currentOffer, prevWant) ??
                colors[prevIndex % colors.length];

            // `publicMatchRequest`: whitelist de salida (identidad + offer/want +
            // user acotado). Nunca expone location/flags internos aunque el doc los
            // trajera. Los colores del par se agregan aparte (no viven en el doc).
            return {
                ...publicMatchRequest(request),
                offerColor,
                wantColor,
            };
        });

        const round3 = (n: number) => Number((n ?? 0).toFixed(3));

        // Anticipo "doble vacío": TODOS los participantes ofrecen vacío y piden
        // vacío. Dos (o más) personas que no ofrecen ni piden nada y se encontraron
        // → la UI muestra el mensaje de "¿ya están conversando?". Es una feature
        // más entre tantas; no se promueve de más.
        const isFullEmpty =
            cycleSize > 0 &&
            m.ids.every((id) => {
                const r = populatedMap.get(id);
                return isEmptyToken(r?.offer) && isEmptyToken(r?.want);
            });

        return {
            matchRequest: matchRequestsWithColors,
            matchScore: Number(m.score.toFixed(3)),
            type: m.type,
            isFullEmpty,
            // Nº de participantes del trato (= matchRequest.length).
            size: m.ids.length,
            // Desglose del puntaje para la UI "why you matched".
            scoreParts: {
                sem: round3(m.parts.sem),
                rep: round3(m.parts.rep),
                prox: round3(m.parts.prox),
                fresh: round3(m.parts.fresh),
            },
        };
    });

    // Shadow muestreado: compara feed con legacy DESPUÉS de servir. Nunca
    // afecta la respuesta ni la espera del usuario.
    if (MATCHING.feedShadow && Math.random() < MATCHING.feedShadowSample) {
        void shadowCompareMatches(
            bondRequestId,
            cached,
            MATCHING.feedRead ? 'feed' : 'legacy'
        ).catch((e) =>
            logger.warn(`[matching][shadow] fallo: ${(e as Error)?.message}`)
        );
    }

    bondMatchStatusTotal.inc({ status: 'ready' });

    return {
        // Cache fresca servida: cómputo listo.
        status: 'ready',
        reactivated,
        // Total real de matches SERVIDOS (topeado a 100 y ≥ umbral): coherente con
        // la paginación → el front nunca muestra más de ceil(100/limit) páginas.
        total: served.length,
        page,
        limit,
        data: result,
    };
};

// Bonds PÚBLICOS de un usuario para las tarjetas "Personas"/perfil (ofertas/deseos).
// Solo bonds vivos/navegables: WAITING_FOR_LINK u ONGOING y no pausados.
// Excluye los vectores (offerVector/wantVector) por proyección de inclusión.
const getBondRequestsByUser = async (
    userId: string,
    viewerId?: string,
    searchTerm?: string,
    pageArg?: unknown,
    limitArg?: unknown
) => {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid user id');
    }

    // Paginación: de a 10 por defecto. `page` >= 1; `limit` acotado a [1,50] para
    // que un cliente no pida una página gigante. El front muestra el conteo total
    // y navega por páginas.
    // Mismo helper que el resto. La versión a mano que había acá dejaba pasar
    // `?page=1e999` (`Math.max(1, Infinity)` sigue siendo Infinity) y ACÁ sí
    // rompe: a diferencia del serving del matcheo —que pagina en memoria con
    // `.slice()` y con Infinity devuelve vacío— este endpoint va a Mongo con
    // `.skip(Infinity)` → 500.
    const page = clampPage(pageArg);
    const limit = clampLimit(limitArg, 10, 50);
    const skip = (page - 1) * limit;

    const isOwner = !!viewerId && viewerId.toString() === userId.toString();

    const filter: Record<string, unknown> = {
        user: userId,
        status: {
            $in: [
                ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
                ENUM_BOND_REQUEST_STATUS.ONGOING,
            ],
        },
        isPause: false,
        // Un vínculo soft-deleted no se lista en el perfil ni en las tarjetas.
        isDeleted: { $ne: true },
    };

    const target = await NormalUser.findById(userId)
        .select('bondsPublic')
        .lean();
    const bondsPublic = target ? (target as any).bondsPublic !== false : true;

    // Bloqueos PRIMERO: si quien mira tiene relación de bloqueo con el objetivo, no
    // se exponen sus bonds NI su conteo. Va ANTES que la rama de privacidad porque,
    // si no, a un viewer bloqueado que abría el perfil de alguien con vínculos
    // privados se le devolvía el conteo REAL (se filtraba cuántos vínculos tiene).
    // Respuesta indistinguible: 0.
    if (viewerId && !isOwner) {
        const blockedIds = await getBlockedIdsFor(viewerId);
        if (blockedIds.includes(userId)) {
            return { bondsPublic, count: 0, bonds: [], page, limit };
        }
    }

    // PRIVACIDAD (cambio 24/7): ocultar es ocultar de verdad en el DESCUBRIMIENTO.
    // Antes el backend SIEMPRE mandaba la lista y el front decidía taparla, así
    // que en la tarjeta de Personas se filtraba igual el último vínculo. Ahora, si
    // el dueño ocultó sus vínculos y quien mira NO es el dueño, el backend NO
    // manda la lista: sólo el flag y el conteo (para la etiqueta "N privados").
    // OJO: esto NO afecta el matcheo — el motor ignora `bondsPublic`, así que un
    // vínculo oculto sigue matcheando y apareciendo en las cadenas de intercambio.
    if (!bondsPublic && !isOwner) {
        const count = await BondRequest.countDocuments(filter);
        return { bondsPublic, count, bonds: [], page, limit };
    }

    // Buscador de vínculos DENTRO del perfil: filtra por ofrece/busca/descripción,
    // insensible a acentos y mayúsculas (mismo criterio que la búsqueda de
    // Personas). Sin término, se listan los más nuevos como antes. Con término, se
    // busca sobre TODOS los vínculos de la persona (no sólo los 20 más recientes),
    // que es justo el punto: encontrar uno entre cientos sin scrollear.
    const term = typeof searchTerm === 'string' ? searchTerm.trim() : '';
    if (term) {
        const rx = buildLooseRegex(term);
        filter.$or = [{ offer: rx }, { want: rx }, { description: rx }];
    }

    const count = await BondRequest.countDocuments(filter);

    const bonds = await BondRequest.find(filter)
        // Privacidad: NO exponer `location` (coordenadas). Se muestran
        // ofrece/busca y modalidad, nunca dónde vive la persona.
        .select('offer want description modality radius status createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

    return { bondsPublic, count, bonds, page, limit };
};

/* Cupo visible del plan: cuántos vínculos ocupa y cuánto le queda.
 * Usa el MISMO filtro que `createBondRequestIntoDB` (FILTRO_CUPO_VINCULOS), así
 * que el número mostrado y el chequeo del 403 no pueden divergir. Es una lectura
 * aparte de `myBondRequests`: esa lista excluye `isLinked`, y un vínculo linkeado
 * SÍ sigue ocupando cupo (sólo eliminarlo lo libera). */
const getBondQuota = async (userId: string) => {
    const [user, used] = await Promise.all([
        NormalUser.findById(userId).select('bondLimit'),
        BondRequest.countDocuments({ user: userId, ...FILTRO_CUPO_VINCULOS }),
    ]);

    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    const limit = user.bondLimit ?? 25;

    return {
        used,
        limit,
        remaining: Math.max(0, limit - used),
    };
};

const bondRequestService = {
    createBondRequestIntoDB,
    getBondRequestsByUser,
    getAllBondRequests,
    getSingleBondRequest,
    updateBondRequestIntoDB,
    deleteBondRequestFromDB,
    myBondRequests,
    getBondQuota,
    getMatchingBondRequest,
    getLastBond,
};

export default bondRequestService;
