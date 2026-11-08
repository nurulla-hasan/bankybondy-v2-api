import type { ClientSession, Model } from 'mongoose';
import AppError from '../../error/appError';
import type { IBondRequest } from './bondRequest.interface';
import type { IBondLink } from '../bondLink/bondLink.interface';
import type { IConversation } from '../conversation/conversation.interface';
import { ENUM_BOND_REQUEST_STATUS } from './bondRequest.enum';
import { ENUM_BOND_LINK_STATUS } from '../bondLink/bondLink.enum';
import { ENUM_CONVERSATION_TYPE } from '../conversation/conversation.enum';
import { BOND_TRANSACTION_OPTIONS } from '../../shared/bondTransactionOptions';

type Dependencies = {
    bonds: Model<IBondRequest>;
    links: Model<IBondLink>;
    conversations: Model<IConversation>;
    startSession: () => Promise<ClientSession>;
};

export const createBondIntegrity = ({ bonds, links, conversations, startSession }: Dependencies) => ({
    async createLink(payload: IBondLink, caller: string) {
        const participants = [...new Set(payload.participants.map(String))];
        const ids = [...new Set(payload.requestedBonds.map(String))];
        const session = await startSession();
        try {
            return await session.withTransaction(async () => {
                const rows = await bonds.find({ _id: { $in: ids } }).select('user status isPause').session(session).lean();
                if (rows.length !== ids.length) throw new AppError(400, 'Alguno de los vínculos solicitados no existe.');
                const active = [ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK, ENUM_BOND_REQUEST_STATUS.ONGOING];
                if (rows.some(row => row.isPause === true || !active.includes(row.status))) {
                    throw new AppError(400, 'Alguno de los vínculos no está activo.');
                }
                const owners = new Set(rows.map(row => String(row.user)));
                if (owners.size !== participants.length || participants.some(id => !owners.has(id))) {
                    throw new AppError(400, 'Los participantes deben ser exactamente los dueños de los vínculos.');
                }
                if (payload.requestedBonds.length !== participants.length) throw new AppError(400, 'Debe haber exactamente un vínculo por participante.');
                if (!participants.includes(caller) || !owners.has(caller)) throw new AppError(403, 'Tenés que ser dueño de al menos uno de los vínculos.');
                for (const row of rows.sort((a, b) => String(a._id).localeCompare(String(b._id)))) {
                    const guard = await bonds.updateOne({
                        _id: row._id, user: row.user, status: { $in: active }, isPause: { $ne: true },
                    }, { $inc: { integrityRevision: 1 } }, { session, timestamps: false });
                    if (guard.matchedCount !== 1) throw new AppError(400, 'Alguno de los vínculos no está activo.');
                }
                const [link] = await links.create([{
                    name: payload.name, participants, requestedBonds: payload.requestedBonds,
                    bondsKey: [...ids].sort().join('_'), status: ENUM_BOND_LINK_STATUS.Ongoing,
                }], { session });
                await conversations.create([{
                    participants, type: ENUM_CONVERSATION_TYPE.bondLinkGroup, bondLink: link._id,
                }], { session });
                return link;
            }, BOND_TRANSACTION_OPTIONS);
        } finally {
            await session.endSession();
        }
    },
    async deleteBond(user: string, id: string) {
        const session = await startSession();
        try {
            return await session.withTransaction(async () => {
                const guard = await bonds.updateOne({ _id: id, user },
                    { $inc: { integrityRevision: 1 } }, { session, timestamps: false });
                if (guard.matchedCount !== 1) throw new AppError(404, 'BondRequest not found');
                // Under simple collation Ongoing sorts before Completed, regardless of history count.
                const reference = await links.findOne({ requestedBonds: id,
                    status: { $in: [ENUM_BOND_LINK_STATUS.Ongoing, ENUM_BOND_LINK_STATUS.Completed] },
                }).select('status').sort({ status: -1 }).collation({ locale: 'simple' }).session(session).lean();
                if (reference?.status === ENUM_BOND_LINK_STATUS.Ongoing) {
                    throw new AppError(409, 'No podés borrar un vínculo que forma parte de un vínculo en curso. Cerralo o cancelalo primero.');
                }
                if (reference?.status === ENUM_BOND_LINK_STATUS.Completed) {
                    return await bonds.findOneAndUpdate({ _id: id, user },
                        { $set: { isDeleted: true, isLinked: true, isPause: true } }, { new: true, session });
                }
                return await bonds.findOneAndDelete({ _id: id, user }, { session });
            }, BOND_TRANSACTION_OPTIONS);
        } finally {
            await session.endSession();
        }
    },
});
