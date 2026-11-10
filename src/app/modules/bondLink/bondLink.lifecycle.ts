import httpStatus from 'http-status';
import mongoose, { ClientSession } from 'mongoose';
import AppError from '../../error/appError';
import { ENUM_BOND_LINK_STATUS } from './bondLink.enum';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';
import { BOND_TRANSACTION_OPTIONS } from '../../shared/bondTransactionOptions';

export interface BondLinkLifecycleDependencies {
    BondLink: Pick<typeof import('./bondLink.model').BondLink, 'findById' | 'findOneAndUpdate'>;
    Conversation: Pick<typeof import('../conversation/conversation.model').default, 'updateOne'>;
    BondRating: Pick<typeof import('../bondRating/bondRating.model').default, 'updateMany' | 'distinct'>;
    startSession: () => Promise<ClientSession>;
    sendNotification: typeof import('../../helper/sendNotification').default;
    recomputeReputation: typeof import('../bondRating/reputation.util').recomputeReputation;
    blockUser: typeof import('../userBlock/userBlock.service').default.blockUser;
}

/** Terminal conflicts return 409 (formerly 400). Original membership is still the
 * authorization source, including Canceled self-leave/block retries. Inject
 * connection-bound models and startSession together; external effects stay best-effort.
 */
export function createBondLinkLifecycle(dependencies: BondLinkLifecycleDependencies) {
    const { BondLink, Conversation, BondRating, startSession, recomputeReputation, sendNotification } = dependencies;

    const readParticipantLink = async (profileId: string, bondLinkId: string, session: ClientSession) => {
        const bondLink = await BondLink.findById(bondLinkId).session(session);
        if (!bondLink?.participants.some(p => p?.toString() === profileId.toString())) {
            throw new AppError(httpStatus.NOT_FOUND, 'You are not participant of that bond');
        }
        return bondLink;
    };

    const conflict = (completing: boolean) => new AppError(
        httpStatus.CONFLICT,
        completing
            ? 'Este trueque no se concretó; no se puede completar.'
            : 'No se puede rechazar un trueque ya completado.'
    );

    const markAsCompleteBond = async (profileId: string, bondLinkId: string) => {
        const session = await startSession();
        let outcome: { bondLink: Awaited<ReturnType<typeof readParticipantLink>>; wonCompletion: boolean };
        try {
            outcome = await session.withTransaction(async () => {
                // Callback-local outcomes cannot leak from an aborted retry.
                const bondLink = await readParticipantLink(profileId, bondLinkId, session);
                if (bondLink.status === ENUM_BOND_LINK_STATUS.Completed) {
                    return { bondLink, wonCompletion: false };
                }
                if (bondLink.status !== ENUM_BOND_LINK_STATUS.Ongoing) throw conflict(true);

                const participant = new mongoose.Types.ObjectId(profileId);
                const signed = await BondLink.findOneAndUpdate(
                    { _id: bondLinkId, participants: participant, status: ENUM_BOND_LINK_STATUS.Ongoing },
                    { $addToSet: { markAsCompletedBy: participant } },
                    { new: true, session }
                );
                if (!signed) {
                    const actual = await readParticipantLink(profileId, bondLinkId, session);
                    if (actual.status === ENUM_BOND_LINK_STATUS.Completed) {
                        return { bondLink: actual, wonCompletion: false };
                    }
                    throw conflict(true);
                }
                if (signed.markAsCompletedBy.length !== signed.participants.length) {
                    return { bondLink: signed, wonCompletion: false };
                }
                const completed = await BondLink.findOneAndUpdate(
                    { _id: bondLinkId, participants: participant, status: ENUM_BOND_LINK_STATUS.Ongoing },
                    { $set: { status: ENUM_BOND_LINK_STATUS.Completed } },
                    { new: true, session }
                );
                if (!completed) {
                    const actual = await readParticipantLink(profileId, bondLinkId, session);
                    if (actual.status === ENUM_BOND_LINK_STATUS.Completed) {
                        return { bondLink: actual, wonCompletion: false };
                    }
                    throw conflict(true);
                }
                return { bondLink: completed, wonCompletion: true };
            }, BOND_TRANSACTION_OPTIONS);
        } finally {
            await session.endSession();
        }
        if (outcome.wonCompletion) {
            // reconcileStrandedRatings still repairs interrupted best-effort application.
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

            // Circle closed: notify ALL participants. Best-effort.
            (outcome.bondLink.participants ?? []).forEach((p: any) => {
                sendNotification({
                    title: 'Se cerró el círculo',
                    message: '¡El trueque se completó! ¿Cómo estuvo?',
                    receiver: p.toString(),
                    type: ENUM_NOTIFICATION_TYPE.TRADE_COMPLETED,
                    redirectId: bondLinkId.toString(),
                }).catch(() => undefined);
            });
        }
        return outcome.bondLink;
    };

    const rejectBondLink = async (profileId: string, bondLinkId: string, blockUserIds: string[] = []) => {
        const session = await startSession();
        let outcome: {
            bondLink: Awaited<ReturnType<typeof readParticipantLink>>;
            wonCancellation: boolean;
            canApplyRequestedBlocks: boolean;
        };
        try {
            outcome = await session.withTransaction(async () => {
                let bondLink = await readParticipantLink(profileId, bondLinkId, session);
                const participant = new mongoose.Types.ObjectId(profileId);
                let wonCancellation = false;
                if (bondLink.status === ENUM_BOND_LINK_STATUS.Ongoing) {
                    const canceled = await BondLink.findOneAndUpdate(
                        { _id: bondLinkId, participants: participant, status: ENUM_BOND_LINK_STATUS.Ongoing },
                        { $set: { status: ENUM_BOND_LINK_STATUS.Canceled } },
                        { new: true, session }
                    );
                    if (canceled) {
                        bondLink = canceled;
                        wonCancellation = true;
                    } else {
                        bondLink = await readParticipantLink(profileId, bondLinkId, session);
                    }
                }
                if (bondLink.status !== ENUM_BOND_LINK_STATUS.Canceled) throw conflict(false);
                await Conversation.updateOne(
                    { bondLink: bondLink._id },
                    { $pull: { participants: participant }, $addToSet: { hiddenBy: participant } },
                    { session }
                );
                return { bondLink, wonCancellation, canApplyRequestedBlocks: true };
            }, BOND_TRANSACTION_OPTIONS);
        } finally {
            await session.endSession();
        }
        const participantIds = new Set(
            (outcome.bondLink.participants ?? []).map((p: any) => p.toString())
        );
        const toBlock = [
            ...new Set((blockUserIds ?? []).map((x) => x.toString())),
        ].filter((id) => id !== profileId.toString() && participantIds.has(id));
        for (const blockedId of outcome.canApplyRequestedBlocks ? toBlock : []) {
            // eslint-disable-next-line no-await-in-loop
            await dependencies
                .blockUser(profileId, blockedId)
                .catch(() => undefined);
        }

        // Notify the OTHERS that the trade fell through (their links stay live).
        // Best-effort; only the transition winner notifies.
        if (outcome.wonCancellation) {
            (outcome.bondLink.participants ?? [])
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

        return { status: ENUM_BOND_LINK_STATUS.Canceled, blocked: toBlock, leftChat: true };
    };
    return { markAsCompleteBond, rejectBondLink };
}
