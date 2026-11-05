/* eslint-disable no-useless-catch */
/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import mongoose from 'mongoose';
import QueryBuilder from '../../builder/QueryBuilder';
import AppError from '../../error/appError';
import { invalidateAndRefresh } from '../bondRequest/matching.robot';
import { ENUM_CONVERSATION_TYPE } from '../conversation/conversation.enum';
import Conversation from '../conversation/conversation.model';
import { ENUM_BOND_LINK_STATUS } from './bondLink.enum';
import { IBondLink } from './bondLink.interface';
import { BondLink } from './bondLink.model';
import sendNotification from '../../helper/sendNotification';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';
import BondRequest from '../bondRequest/bondRequest.model';
import BondRating from '../bondRating/bondRating.model';
import { recomputeReputation } from '../bondRating/reputation.util';
import { ENUM_BOND_REQUEST_STATUS } from '../bondRequest/bondRequest.enum';
import userBlockServices, {
    findBlockedPairAmong,
} from '../userBlock/userBlock.service';
import {
    isEmptyToken,
    isSurpriseToken,
} from '../bondRequest/matching.colors';

// Copias por momento (Fase 3, Tanda B). El texto viaja guardado en la
// notificación (mismo patrón que el resto). La clave coincide con el tipo del
// enum para mapear 1:1. El front pinta ícono/color por tipo.
const PROPOSAL_COPY = {
    ENCOUNTER: {
        title: 'Alguien quiere encontrarse',
        message: 'Vinieron a lo mismo: a no estar solos. ¿Empiezan a charlar?',
    },
    GIFT_RECEIVED: {
        title: 'Te hacen un regalo',
        message: 'Alguien te da algo sin pedir nada a cambio.',
    },
    GIFT_GIVEN: {
        title: 'Estás regalando algo',
        message: 'Alguien quiere recibir algo tuyo, a cambio de nada.',
    },
    DOUBLE_SURPRISE: {
        title: 'Doble sorpresa',
        message: 'Se cruzaron dos sorpresas. Pónganse de acuerdo y disfruten.',
    },
    TRADE_PROPOSED: {
        title: 'Te propusieron un trueque',
        message: 'Alguien te eligió para un trueque. Entrá a ver qué te trae.',
    },
} as const;

/**
 * Clasifica el momento de UN participante en el ciclo propuesto, con la MISMA
 * regla que matching.colors.ts (per-entry, asimétrica):
 *  - su oferta Y su deseo vacíos            → ENCUENTRO (doble vacío).
 *  - su oferta vacía (da nada, recibe algo) → REGALO RECIBIDO.
 *  - su deseo vacío (da algo, recibe nada)  → REGALO DADO.
 *  - doble sorpresa en cualquiera de sus dos lados (su token y el del par,
 *    ambos 'surprise') → DOBLE SORPRESA. El deseo lo satisface la oferta del
 *    SIGUIENTE; su oferta satisface el deseo del ANTERIOR (ciclo).
 *  - si no → trueque normal.
 */
const classifyProposalMoment = (
    cycle: Array<{ offer?: string; want?: string }>,
    i: number
): keyof typeof PROPOSAL_COPY => {
    const n = cycle.length;
    const own = cycle[i] || {};
    const offerEmpty = isEmptyToken(own.offer);
    const wantEmpty = isEmptyToken(own.want);
    if (offerEmpty && wantEmpty) return 'ENCOUNTER';
    if (offerEmpty) return 'GIFT_RECEIVED';
    if (wantEmpty) return 'GIFT_GIVEN';
    const nextOffer = cycle[(i + 1) % n]?.offer;
    const prevWant = cycle[(i - 1 + n) % n]?.want;
    const wantDoubleSurprise =
        isSurpriseToken(own.want) && isSurpriseToken(nextOffer);
    const offerDoubleSurprise =
        isSurpriseToken(own.offer) && isSurpriseToken(prevWant);
    if (wantDoubleSurprise || offerDoubleSurprise) return 'DOUBLE_SURPRISE';
    return 'TRADE_PROPOSED';
};

const createBondLink = async (payload: IBondLink, callerProfileId: string) => {
    const participants = Array.from(new Set(payload.participants ?? []));
    if (participants.length < 2) {
        throw new Error('At least two participant is required.');
    }

    // Anti-IDOR: quien crea el vínculo DEBE ser uno de los participantes. Antes
    // el body definía libremente la lista, así que un usuario podía armar un
    // vínculo (y su conversación) metiendo a terceros sin estar él. El flujo
    // legítimo de "Proponer" siempre incluye al proponente, así que no lo rompe.
    const isCallerParticipant = participants.some(
        (p: any) => p?.toString() === callerProfileId?.toString()
    );
    if (!isCallerParticipant) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'No podés crear un vínculo del que no sos participante.'
        );
    }

    // Bloqueo (invariante "bloqueo total", consistente con chatGroup.create y el
    // chat 1-a-1): un vínculo crea una conversación grupal entre los participantes.
    // Sin este guard, un usuario bloqueado (en cualquier sentido) podía armar el
    // vínculo + chat con IDs de bonos activos y contactar a quien lo bloqueó. Se
    // rechaza si el caller tiene relación de bloqueo con ALGÚN participante.
    // Se valida TODO PAR de participantes, no sólo el caller contra el resto.
    // Antes se miraba únicamente `caller vs participantes`: en un vínculo de tres
    // (A lo crea con B y C), si B tenía bloqueado a C el bloqueo se ignoraba y los
    // dos terminaban en la misma conversación grupal. El bloqueo tiene que valer
    // entre cualquier par, igual que en el 1-a-1.
    const blockedPair = await findBlockedPairAmong(participants);
    if (blockedPair) {
        // El mensaje NO dice quién bloqueó a quién: revelarlo le confirmaría al
        // caller un bloqueo entre terceros que no le incumbe.
        const involucraAlCaller =
            blockedPair.blocker === callerProfileId?.toString() ||
            blockedPair.blocked === callerProfileId?.toString();
        throw new AppError(
            httpStatus.FORBIDDEN,
            involucraAlCaller
                ? 'No podés crear un vínculo con un usuario bloqueado.'
                : 'No se puede crear el vínculo: hay un bloqueo entre dos de los participantes.'
        );
    }

    const requestedBonds = Array.isArray(payload.requestedBonds)
        ? payload.requestedBonds
        : [];

    // Anti-forja (M1): un vínculo se forma con BONOS reales. Sin validar
    // `requestedBonds`, un usuario podía crear un BondLink + conversación grupal
    // metiendo IDs de terceros ARBITRARIOS (con solo incluirse él en participants)
    // y spamearlos con notificaciones, y adjuntar bonos ajenos/inexistentes. Se
    // exige: (1) que haya bonos; (2) que existan y estén ACTIVOS; (3) que el
    // conjunto de sus DUEÑOS sea EXACTAMENTE los participantes; (4) que el caller
    // sea dueño de al menos uno. Así los participantes quedan atados a bonos reales
    // y no a IDs sueltos. (El guard de "caller ∈ participants" ya está arriba.)
    const uniqueRequestedBonds = Array.from(
        new Set(requestedBonds.map((b: any) => b.toString()))
    );
    if (uniqueRequestedBonds.length === 0) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Un vínculo necesita los vínculos (bonos) que lo forman.'
        );
    }
    const bondsForValidation: any[] = await BondRequest.find({
        _id: { $in: uniqueRequestedBonds },
    })
        .select('user status isPause')
        .lean();
    if (bondsForValidation.length !== uniqueRequestedBonds.length) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Alguno de los vínculos solicitados no existe.'
        );
    }
    const ACTIVE_BOND_STATUSES: string[] = [
        ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
        ENUM_BOND_REQUEST_STATUS.ONGOING,
    ];
    const someInactive = bondsForValidation.some(
        (b: any) =>
            b.isPause === true || !ACTIVE_BOND_STATUSES.includes(b.status)
    );
    if (someInactive) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Alguno de los vínculos no está activo.'
        );
    }
    const ownerSet = new Set(
        bondsForValidation.map((b: any) => b.user?.toString())
    );
    const participantSet = new Set(
        participants.map((p: any) => p?.toString())
    );
    const sameOwners =
        ownerSet.size === participantSet.size &&
        [...participantSet].every((p) => ownerSet.has(p));
    if (!sameOwners) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Los participantes deben ser exactamente los dueños de los vínculos.'
        );
    }
    // Cardinalidad 1-a-1: exactamente un vínculo por participante (ciclo bien
    // formado). `sameOwners` valida el CONJUNTO de dueños pero permitía 2 bonos del
    // mismo user + 1 de otro (mismo set, distinta cantidad) → ciclo deforme. Exigir
    // la misma cantidad cierra ese hueco (y de paso rechaza bonos duplicados).
    if (payload.requestedBonds?.length !== participants.length) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Debe haber exactamente un vínculo por participante.'
        );
    }
    if (!ownerSet.has(callerProfileId?.toString())) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'Tenés que ser dueño de al menos uno de los vínculos.'
        );
    }

    // R2-6 — Llave de idempotencia: ids de bonos ORDENADOS y UNICOS unidos por
    // '_'. Determinista (mismo conjunto → misma llave, sin importar el orden que
    // mande el front). El indice unico parcial {bondsKey, status:Ongoing} usa esto
    // para que un doble-submit no cree DOS vinculos activos con los mismos bonos.
    const bondsKey = [...uniqueRequestedBonds].sort().join('_');

    const session = await mongoose.startSession();
    let createdBondLinkDoc: any;

    try {
        await session.withTransaction(
            async () => {
                // Campos EXPLICITOS (no `...payload`): un vinculo nace SIEMPRE
                // Ongoing. La validacion permitia `status` en el body, asi que
                // un cliente podia crear un vinculo ya Completed/Canceled (que
                // ademas esquivaba el indice parcial). Se ignora ese status.
                const [bondLink] = await BondLink.create(
                    [
                        {
                            name: payload.name,
                            participants,
                            requestedBonds: payload.requestedBonds,
                            bondsKey,
                            status: ENUM_BOND_LINK_STATUS.Ongoing,
                        },
                    ],
                    { session }
                );
                createdBondLinkDoc = bondLink;

                // Al linkear NO se saca ningun vinculo del pool: un vinculo sigue
                // vivo y recibiendo propuestas hasta que su dueno lo pause (isPause).
                // Solo se crea la conversacion del grupo para coordinar el intercambio.
                await Conversation.create(
                    [
                        {
                            participants,
                            type: ENUM_CONVERSATION_TYPE.bondLinkGroup,
                            bondLink: bondLink._id,
                        },
                    ],
                    { session }
                );
            },
            {
                readConcern: { level: 'local' },
                writeConcern: { w: 'majority' },
                readPreference: 'primary',
            }
        );

        // Tras el link, refrescamos las cachés de los vínculos involucrados. NO se
        // desactivan (siguen en el pool); solo se recalculan para quedar al día.
        for (const bondId of requestedBonds) {
            // active=true: el vínculo sigue VIVO en el pool tras el link, así
            // que se recomputa (no solo se refrescan afectados).
            invalidateAndRefresh(bondId.toString(), true).catch(
                () => undefined
            );
        }

        // Notificación (Fase 2 + 3): avisar a los DEMÁS participantes. Ahora con
        // los MOMENTOS ESPECIALES por participante (regalo/doble sorpresa/doble
        // vacío), clasificados con la misma regla que matching.colors.ts.
        // Desacoplado (fire-and-forget): corre DESPUÉS del return, así no demora
        // ni rompe la creación del vínculo pase lo que pase.
        const linkId = createdBondLinkDoc?._id?.toString();
        void (async () => {
            try {
                // Reconstruimos el ciclo en el ORDEN de requestedBonds (que es el
                // orden del ciclo que armó el front). Cada vínculo trae user +
                // offer/want (los tokens 'empty'/'surprise' viven ahí).
                const bonds: any[] = await BondRequest.find({
                    _id: { $in: requestedBonds },
                })
                    .select('user offer want')
                    .lean();
                const byId = new Map(
                    bonds.map((b: any) => [b._id.toString(), b])
                );
                const cycle = requestedBonds
                    .map((id: any) => byId.get(id.toString()))
                    .filter(Boolean) as Array<{
                    user?: any;
                    offer?: string;
                    want?: string;
                }>;

                const notified = new Set<string>();

                if (cycle.length >= 2) {
                    cycle.forEach((bond, i) => {
                        const receiver = bond?.user?.toString();
                        if (
                            !receiver ||
                            receiver === callerProfileId?.toString() ||
                            notified.has(receiver)
                        )
                            return;
                        notified.add(receiver);
                        const kind = classifyProposalMoment(cycle, i);
                        const copy = PROPOSAL_COPY[kind];
                        sendNotification({
                            title: copy.title,
                            message: copy.message,
                            receiver,
                            type: ENUM_NOTIFICATION_TYPE[kind],
                            redirectId: linkId,
                        }).catch(() => undefined);
                    });
                }

                // Fallback: si no se pudo reconstruir el ciclo (datos raros),
                // igual avisamos a los demás con el trueque normal. Nunca se
                // queda alguien sin su notificación.
                if (notified.size === 0) {
                    const copy = PROPOSAL_COPY.TRADE_PROPOSED;
                    participants
                        .filter(
                            (p: any) =>
                                p?.toString() !== callerProfileId?.toString()
                        )
                        .forEach((p: any) => {
                            sendNotification({
                                title: copy.title,
                                message: copy.message,
                                receiver: p.toString(),
                                type: ENUM_NOTIFICATION_TYPE.TRADE_PROPOSED,
                                redirectId: linkId,
                            }).catch(() => undefined);
                        });
                }
            } catch {
                // best-effort: cualquier error acá jamás afecta el vínculo ya creado.
            }
        })();

        return createdBondLinkDoc?.toObject
            ? createdBondLinkDoc.toObject()
            : createdBondLinkDoc;
    } catch (err: any) {
        // R2-6 — Doble-submit: el indice unico parcial rechaza el 2do insert con
        // E11000. En vez de un 500, respondemos IDEMPOTENTE: devolvemos el vinculo
        // activo que ya existe (el 1er request gano la carrera y ya notifico, asi
        // que aca NO se re-notifica). Si no aparece (caso raro), 409 limpio.
        const isDup =
            err?.code === 11000 ||
            err?.cause?.code === 11000 ||
            err?.codeName === 'DuplicateKey';
        if (isDup) {
            const existing = await BondLink.findOne({
                bondsKey,
                status: ENUM_BOND_LINK_STATUS.Ongoing,
            });
            if (existing) {
                return existing.toObject();
            }
            throw new AppError(
                httpStatus.CONFLICT,
                'Ya existe un vínculo activo con estos vínculos.'
            );
        }
        throw err;
    } finally {
        session.endSession();
    }
};

const getMyBondLinks = async (
    userId: string,
    query: Record<string, unknown>
) => {
    // Estado (Ongoing / Completed / Canceled): el front lo manda como ?status=,
    // pero QueryBuilder lo descarta A PROPÓSITO — `status` está en
    // BLOCKED_FILTER_FIELDS para evitar que un cliente fuerce el estado. El
    // efecto colateral era que las pestañas "En curso" y "Completados" recibían
    // exactamente la misma lista. Se resuelve acá: se lee el valor pedido, se
    // valida contra el enum y se fija en el find BASE. Así el cliente elige
    // entre estados conocidos y nunca puede inyectar un filtro arbitrario, que
    // es justamente lo que protege la lista negra.
    const requestedStatus = String(query.status ?? '');
    const statusFilter = Object.values(ENUM_BOND_LINK_STATUS).includes(
        requestedStatus
    )
        ? { status: requestedStatus }
        : {};

    const resultQuery = new QueryBuilder(
        BondLink.find({ participants: userId, ...statusFilter }).populate({
            path: 'requestedBonds',
            // Excluye las COORDENADAS GPS exactas (PII) y los vectores ML (bloat)
            // del BondRequest. El resto (offer/want/description/etc.) lo usa
            // MatchGroup en las listas En curso/Completados; sólo `location` y los
            // vectores eran de más y filtraban la ubicación de los co-participantes.
            select: '-location -offerVector -wantVector',
            populate: { path: 'user', select: 'name profile_image' },
        }),
        query
    )
        .search(['name'])
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

const getSingleBondLink = async (profileId: string, id: string) => {
    const bondLink: any = await BondLink.findOne({
        participants: new mongoose.Types.ObjectId(profileId),
        _id: id,
    }).populate({
        // Ciclo del intercambio (para el "círculo del intercambio" del chat): cada
        // bono con su dueño + offer/want, en el orden del anillo. Mismo populate que
        // getMyBondLinks — antes el single devolvía sólo IDs y el front no podía
        // dibujar quién ofrece/pide qué.
        path: 'requestedBonds',
        // SÓLO lo que el círculo necesita. SIN este select, el populate traía el
        // BondRequest COMPLETO — incluidas las COORDENADAS GPS exactas de todos los
        // co-participantes (fuga de PII a cualquiera del trueque).
        select: 'user offer want',
        populate: { path: 'user', select: 'name profile_image' },
    });

    if (!bondLink) {
        throw new AppError(httpStatus.NOT_FOUND, 'Bond link not found');
    }

    let isMarkAsCompletedByYou = false;
    // .includes() sobre ObjectId compara por REFERENCIA (nunca matchea un
    // ObjectId recién creado) → siempre daba false. Comparo por string.
    if (
        (bondLink.markAsCompletedBy ?? []).some(
            (x: any) => x?.toString() === profileId.toString()
        )
    ) {
        isMarkAsCompletedByYou = true;
    }

    // ¿A quién le falta que califiques? Sin este dato el front NO tenía forma de
    // ofrecer la calificación más tarde: el modal se abría UNA sola vez, justo
    // después de marcar el trueque como completado. Si el vínculo se completaba
    // cuando vos no estabas (lo cerró el otro participante), no volvías a ver el
    // modal NUNCA y te quedabas sin poder dar reputación.
    //
    // Se devuelve la lista de participantes (distintos de vos) que todavía no
    // calificaste. El front la usa para mostrar el botón de calificar mientras
    // quede alguien pendiente. Sólo tiene sentido en un vínculo completado.
    // Se calcula desde que VOS marcaste completado (no desde que el vínculo entero
    // lo está): así podés calificar a tu tiempo, sin esperar a que los demás
    // cierren su parte. Mismo criterio que el guard de addRating.
    let pendingRatingFor: string[] = [];
    if (isMarkAsCompletedByYou) {
        const yaCalificados = await BondRating.find({
            ratedBy: new mongoose.Types.ObjectId(profileId),
            bondLink: bondLink._id,
        })
            .select('rated')
            .lean();
        const yaCalificadosSet = new Set(
            yaCalificados.map((r: any) => r.rated?.toString())
        );
        pendingRatingFor = (bondLink.participants ?? [])
            .map((p: any) => p?.toString())
            .filter(
                (p: string) =>
                    p !== profileId.toString() && !yaCalificadosSet.has(p)
            );
    }

    return {
        ...bondLink.toObject(),
        isMarkAsCompletedByYou,
        pendingRatingFor,
        canRate: pendingRatingFor.length > 0,
    };
};

const markAsCompleteBond = async (profileId: string, bondLinkId: string) => {
    const bondLink = await BondLink.findById(bondLinkId);
    // .includes() sobre ObjectId compara por REFERENCIA → siempre daba false,
    // así que este guard SIEMPRE tiraba "no sos participante" y rompía por
    // completo el "marcar como completado". Comparo por string.
    if (
        !bondLink?.participants.some(
            (x: any) => x?.toString() === profileId.toString()
        )
    ) {
        throw new AppError(
            httpStatus.NOT_FOUND,
            'You are not participant of that bond'
        );
    }

    // Un trueque NO CONCRETADO (Canceled) no se puede completar. Sin este guard,
    // marcar completado sobre un Canceled agregaba al usuario a markAsCompletedBy
    // y (frágil) el filtro `status != Completed` de más abajo podía transicionar
    // Canceled→Completed.
    if (bondLink.status === ENUM_BOND_LINK_STATUS.Canceled) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Este trueque no se concretó; no se puede completar.'
        );
    }

    // Si el vínculo YA está completado, no re-procesar: el $addToSet de abajo
    // sería no-op y se volvería a cumplir el umbral → se re-dispararía
    // TRADE_COMPLETED a todos (spam + infla el digest + re-sube el badge). Se
    // dispara SOLO en la transición a completado.
    if (bondLink.status === ENUM_BOND_LINK_STATUS.Completed) {
        return bondLink;
    }

    const result = await BondLink.findOneAndUpdate(
        {
            _id: bondLinkId,
            participants: new mongoose.Types.ObjectId(profileId),
        },
        {
            $addToSet: {
                markAsCompletedBy: new mongoose.Types.ObjectId(profileId),
            },
        },
        { new: true }
    );

    if (!result) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Maybe you are not participant of that bond , if you please contact with admin'
        );
    }
    if (result?.markAsCompletedBy.length === bondLink.participants.length) {
        // Transición ATÓMICA: el cambio de estado a Completed es el gate que
        // decide quién notifica. Antes el guard era una lectura previa + un
        // findByIdAndUpdate separado → con doble-tap concurrente (o los dos
        // últimos marcando a la vez) ambos requests veían el umbral cumplido y
        // re-disparaban TRADE_COMPLETED a todos. Ahora se transiciona con filtro
        // `status != Completed`: MongoDB serializa la escritura sobre el doc, así
        // que UN solo request obtiene un doc no-null (el que ganó la transición)
        // y es el único que notifica. `findOneAndUpdate` sin `new:true` devuelve
        // el doc PREVIO (null si el filtro ya no matchea = otro ganó).
        const justCompleted = await BondLink.findOneAndUpdate(
            {
                _id: bondLinkId,
                status: { $ne: ENUM_BOND_LINK_STATUS.Completed },
            },
            { status: ENUM_BOND_LINK_STATUS.Completed }
        );

        // `result` se leyó ANTES de esta transición, así que todavía trae
        // status:'Ongoing' aunque el trueque acabe de cerrarse. Devolverlo así
        // dejaba al front sin forma de distinguir "lo marqué yo y falta el otro"
        // de "se cerró el círculo": abría el modal de calificación siempre, y al
        // primero que marcaba el backend le rechazaba la reseña (solo se puede
        // calificar un vínculo Completed). Se refleja el estado REAL.
        // Vale en las dos ramas: si `justCompleted` es null es porque OTRO request
        // ganó la transición, pero el vínculo quedó completado igual.
        result.status = ENUM_BOND_LINK_STATUS.Completed;

        if (justCompleted) {
            // RATING EN SUSPENSO → APLICAR EN LOTE: el círculo cerró (todos
            // completaron), así que todas las calificaciones de este trueque pasan a
            // `applied:true` y se recalcula la reputación de cada calificado. Un
            // trueque inconcluso NUNCA llega acá → sus ratings quedan en suspenso
            // (no generan reputación). Best-effort: si el proceso muere a mitad, el
            // sweep de reconciliación (reconcileStrandedRatings, en el worker) re-aplica
            // las reseñas de trueques ya Completed que quedaron en applied:false.
            try {
                await BondRating.updateMany(
                    { bondLink: bondLinkId, applied: { $ne: true } },
                    { $set: { applied: true } }
                );
                const ratedIds: any[] = await BondRating.distinct('rated', {
                    bondLink: bondLinkId,
                });
                await Promise.all(
                    ratedIds.map((rid) =>
                        recomputeReputation(rid.toString()).catch(
                            () => undefined
                        )
                    )
                );
            } catch {
                /* best-effort */
            }

            // Se cerró el círculo → avisar a TODOS los participantes. Best-effort.
            (bondLink.participants ?? []).forEach((p: any) => {
                sendNotification({
                    title: 'Se cerró el círculo',
                    message: '¡El trueque se completó! ¿Cómo estuvo?',
                    receiver: p.toString(),
                    type: ENUM_NOTIFICATION_TYPE.TRADE_COMPLETED,
                    redirectId: bondLinkId.toString(),
                }).catch(() => undefined);
            });
        }
    }
    return result;
};

/** Rechazar un trueque → lo da por NO CONCRETADO (status Canceled) para TODOS.
 *  El que rechaza SALE del chat (soft-hide por `hiddenBy`: no se borra, los demás
 *  lo conservan como historial y pueden seguir hablando). Opcionalmente bloquea a
 *  participantes elegidos — SIEMPRE excluyendo al propio usuario (nadie se bloquea
 *  a sí mismo) y sólo a participantes de ESTE trueque (no sirve para bloquear a
 *  terceros). Cancelar NO toca los vínculos de nadie: siguen activos y matcheando,
 *  se puede re-proponer en otra oportunidad. */
const rejectBondLink = async (
    profileId: string,
    bondLinkId: string,
    blockUserIds: string[] = []
) => {
    const bondLink = await BondLink.findById(bondLinkId);
    // Guarda de participante (comparación por string: .includes sobre ObjectId
    // compara por referencia y nunca matchea).
    if (
        !bondLink?.participants.some(
            (x: any) => x?.toString() === profileId.toString()
        )
    ) {
        throw new AppError(
            httpStatus.NOT_FOUND,
            'You are not participant of that bond'
        );
    }

    // No se puede rechazar un trueque ya COMPLETADO (el intercambio ya ocurrió):
    // evita ocultar/bloquear sobre un cierre real y devolver un status mentiroso.
    if (bondLink.status === ENUM_BOND_LINK_STATUS.Completed) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'No se puede rechazar un trueque ya completado.'
        );
    }

    // Transición ATÓMICA a Canceled: sólo el request que la gana notifica a los
    // demás (evita spam si dos rechazan casi a la vez). Idempotente: si ya estaba
    // Canceled, `justCanceled` es null y no re-notifica. El status devuelto es
    // veraz: acá el estado sólo puede ser Ongoing (→Canceled) o ya Canceled.
    const justCanceled = await BondLink.findOneAndUpdate(
        { _id: bondLinkId, status: ENUM_BOND_LINK_STATUS.Ongoing },
        { status: ENUM_BOND_LINK_STATUS.Canceled }
    );

    // "Sale del chat" = salida REAL: se lo saca de `participants` (así los guards de
    // participante en getMessages/getMediaFiles lo bloquean → no puede seguir leyendo
    // el historial/media por REST, ni ver los mensajes que los demás manden después),
    // y se agrega a `hiddenBy` (defensa + coherencia). Los demás quedan como
    // participantes y conservan el chat. El ocultar VOLUNTARIO (declutter) sigue
    // usando SOLO `hiddenBy` (queda leíble a propósito). Idempotente.
    await Conversation.updateOne(
        { bondLink: bondLink._id },
        {
            $pull: { participants: new mongoose.Types.ObjectId(profileId) },
            $addToSet: { hiddenBy: new mongoose.Types.ObjectId(profileId) },
        }
    );

    // Bloqueos opcionales: SIEMPRE excluyendo al propio usuario y validando que el
    // objetivo sea participante de ESTE trueque. blockUser ya es idempotente y ya
    // rechaza el self-block (doble red). Best-effort: un bloqueo que falle no debe
    // tumbar el rechazo.
    const participantIds = new Set(
        (bondLink.participants ?? []).map((p: any) => p.toString())
    );
    const toBlock = [
        ...new Set((blockUserIds ?? []).map((x) => x.toString())),
    ].filter((id) => id !== profileId.toString() && participantIds.has(id));
    for (const blockedId of toBlock) {
        // eslint-disable-next-line no-await-in-loop
        await userBlockServices
            .blockUser(profileId, blockedId)
            .catch(() => undefined);
    }

    // Aviso a los DEMÁS: el trueque no se concretó (sus vínculos siguen vivos).
    // Best-effort; sólo el que ganó la transición notifica.
    if (justCanceled) {
        (bondLink.participants ?? [])
            .filter((p: any) => p.toString() !== profileId.toString())
            .forEach((p: any) => {
                sendNotification({
                    title: 'Un trueque no se concretó',
                    message:
                        'Se rechazó la propuesta. Tus vínculos siguen activos y buscando nuevos trueques.',
                    receiver: p.toString(),
                    type: ENUM_NOTIFICATION_TYPE.GENERAL,
                    redirectId: bondLinkId.toString(),
                }).catch(() => undefined);
            });
    }

    return {
        status: ENUM_BOND_LINK_STATUS.Canceled,
        blocked: toBlock,
        leftChat: true,
    };
};

const BondLinkServices = {
    getMyBondLinks,
    createBondLink,
    markAsCompleteBond,
    getSingleBondLink,
    rejectBondLink,
};
export default BondLinkServices;
