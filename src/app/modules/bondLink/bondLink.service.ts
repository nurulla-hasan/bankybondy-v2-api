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

// Per-moment copy. Text is stored in the notification itself; keys map 1:1 to
// the enum type (front renders icon/color per type).
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
 * Classifies one participant's moment in the proposed cycle with the same
 * per-entry, asymmetric rule as matching.colors.ts (empty offer+want, empty
 * offer, empty want, surprise pair, else normal trade).
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

    // Anti-IDOR: the caller MUST be a participant. The body used to define the
    // list freely, so one could link (and chat with) third parties uninvited.
    const isCallerParticipant = participants.some(
        (p: any) => p?.toString() === callerProfileId?.toString()
    );
    if (!isCallerParticipant) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'No podés crear un vínculo del que no sos participante.'
        );
    }

    // Block invariant: check EVERY participant pair, not just caller vs rest.
    // With only the caller check, a trio where B blocked C still got a shared
    // group chat; the block must hold between any pair, as in 1-to-1 chat.
    const blockedPair = await findBlockedPairAmong(participants);
    if (blockedPair) {
        // Message never says who blocked whom: that would confirm a block
        // between third parties to the caller.
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

    // Anti-forge (M1): bonds must exist, be ACTIVE, their owners must be EXACTLY
    // the participants, and the caller must own one. Otherwise arbitrary ids let
    // anyone spam strangers and attach foreign/nonexistent bonds.
    const uniqueRequestedBonds = Array.from(
        new Set(requestedBonds.map((b: any) => b.toString()))
    );
    if (uniqueRequestedBonds.length === 0) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Un vínculo necesita las solicitudes que lo forman.'
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
    // 1:1 cardinality: exactly one bond per participant. `sameOwners` only checked
    // the owner SET, so two bonds of one user + one of another still passed.
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

    // R2-6 idempotency key: sorted unique bond ids joined by '_' (order
    // independent). The partial unique index {bondsKey, status:Ongoing} uses it
    // so a double submit cannot create two active links with the same bonds.
    const bondsKey = [...uniqueRequestedBonds].sort().join('_');

    let createdBondLinkDoc: any;
    try {
        createdBondLinkDoc = await createBondIntegrity({
            bonds: BondRequest, links: BondLink, conversations: Conversation,
            startSession: () => mongoose.startSession(),
        }).createLink(payload, callerProfileId);

        // Refresh the involved bonds' caches after linking. They are NOT
        // deactivated (still in the pool), just recomputed.
        for (const bondId of requestedBonds) {
            // active=true: the link stays alive in the pool after linking.
            invalidateAndRefresh(bondId.toString(), true).catch(
                () => undefined
            );
        }

        // Notify the OTHER participants with their per-participant moment,
        // classified by the same rule as matching.colors.ts. Fire-and-forget:
        // runs after return, so it never delays nor breaks the creation.
        const linkId = createdBondLinkDoc?._id?.toString();
        void (async () => {
            try {
                // Rebuild the cycle in requestedBonds order (the front's ring
                // order); each bond carries user + offer/want tokens.
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

                // Fallback: if the cycle could not be rebuilt (odd data), still
                // notify the others with the normal trade copy.
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
                // best-effort: errors here never affect the created link.
            }
        })();

        return createdBondLinkDoc?.toObject
            ? createdBondLinkDoc.toObject()
            : createdBondLinkDoc;
    } catch (err: any) {
        // R2-6 double submit: the partial unique index rejects the 2nd insert
        // with E11000. Respond idempotently with the existing active link (the
        // 1st request won the race and already notified, so no re-notify).
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
    // ?status is dropped on purpose by QueryBuilder (BLOCKED_FILTER_FIELDS), so
    // both tabs got the same list. Validate it against the enum and apply it in
    // the base find: known states only, no arbitrary filter injection.
    const requestedStatus = String(query.status ?? '');
    const statusFilter = Object.values(ENUM_BOND_LINK_STATUS).includes(
        requestedStatus
    )
        ? { status: requestedStatus }
        : {};

    const resultQuery = new QueryBuilder(
        BondLink.find({ participants: userId, ...statusFilter }).populate({
            path: 'requestedBonds',
            // Exclude exact GPS coords (PII) and ML vectors (bloat); the rest is
            // used by MatchGroup. location leaked co-participants' position.
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
        // Exchange cycle for the chat's ring view: each bond with owner +
        // offer/want in ring order (the single endpoint used to return ids only).
        path: 'requestedBonds',
        // Only what the ring needs; without this select the full BondRequest
        // (including exact GPS of every co-participant) leaked.
        select: 'user offer want',
        populate: { path: 'user', select: 'name profile_image' },
    });

    if (!bondLink) {
        throw new AppError(httpStatus.NOT_FOUND, 'Bond link not found');
    }

    let isMarkAsCompletedByYou = false;
    // .includes() on ObjectId compares by REFERENCE (never matches a fresh id),
    // so it always returned false. Compare as strings.
    if (
        (bondLink.markAsCompletedBy ?? []).some(
            (x: any) => x?.toString() === profileId.toString()
        )
    ) {
        isMarkAsCompletedByYou = true;
    }

    // Participants (besides you) you have not rated yet. Without it the front
    // could only offer rating once, right after completing: a link the other
    // side closed while you were away left you unable to rate. Counted from when
    // YOU marked it complete (same rule as addRating's guard), not from closing.
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
