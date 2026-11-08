/* eslint-disable no-useless-catch */
/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import mongoose from 'mongoose';
import QueryBuilder from '../../builder/QueryBuilder';
import AppError from '../../error/appError';
import { invalidateAndRefresh } from '../bondRequest/matching.robot';
import Conversation from '../conversation/conversation.model';
import { ENUM_BOND_LINK_STATUS } from './bondLink.enum';
import { IBondLink } from './bondLink.interface';
import { BondLink } from './bondLink.model';
import { createBondLinkLifecycle } from './bondLink.lifecycle';
import { createBondIntegrity } from '../bondRequest/bondIntegrity';
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

    let createdBondLinkDoc: any;
    try {
        createdBondLinkDoc = await createBondIntegrity({
            bonds: BondRequest, links: BondLink, conversations: Conversation,
            startSession: () => mongoose.startSession(),
        }).createLink(payload, callerProfileId);

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

const { markAsCompleteBond, rejectBondLink } = createBondLinkLifecycle({
    BondLink,
    Conversation,
    BondRating,
    startSession: () => mongoose.startSession(),
    sendNotification,
    recomputeReputation,
    blockUser: (profileId, blockedId) => userBlockServices.blockUser(profileId, blockedId),
});

const BondLinkServices = {
    getMyBondLinks,
    createBondLink,
    markAsCompleteBond,
    getSingleBondLink,
    rejectBondLink,
};
export default BondLinkServices;
