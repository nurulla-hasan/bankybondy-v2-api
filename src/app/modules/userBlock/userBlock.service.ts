import httpStatus from 'http-status';
import mongoose, { Types } from 'mongoose';
import QueryBuilder from '../../builder/QueryBuilder';
import AppError from '../../error/appError';
import NormalUser from '../normalUser/normalUser.model';
import UserBlock from './userBlock.model';

/**
 * Ids (as strings) the user blocked PLUS those who blocked them; used to exclude
 * content in key read endpoints. Use `getBlockedObjectIdsFor` when a `$nin` needs ObjectIds.
 */
export const getBlockedIdsFor = async (userId: string): Promise<string[]> => {
    const uid = new Types.ObjectId(userId);
    const rows = await UserBlock.find({
        $or: [{ blocker: uid }, { blocked: uid }],
    })
        .select('blocker blocked')
        .lean();

    const ids = new Set<string>();
    for (const row of rows) {
        const blocker = row.blocker?.toString();
        const blocked = row.blocked?.toString();
        // Add the "other" end of the relation (never the user).
        if (blocker && blocker !== userId) ids.add(blocker);
        if (blocked && blocked !== userId) ids.add(blocked);
    }
    return [...ids];
};

/**
 * Same as getBlockedIdsFor but returns ObjectId[], ready for `{ $nin: [...] }`.
 */
export const getBlockedObjectIdsFor = async (
    userId: string
): Promise<Types.ObjectId[]> => {
    const ids = await getBlockedIdsFor(userId);
    return ids.map((id) => new Types.ObjectId(id));
};

/**
 * First block-related pair (either direction) inside a set of users, or null. A group
 * link is an ALL-vs-ALL conversation, so checking only the creator missed B blocking C.
 * One query beats N `getBlockedIdsFor` calls.
 */
export const findBlockedPairAmong = async (
    userIds: (string | Types.ObjectId)[]
): Promise<{ blocker: string; blocked: string } | null> => {
    const unique = Array.from(
        new Set(userIds.filter(Boolean).map((id) => id.toString()))
    ).filter((id) => Types.ObjectId.isValid(id));
    // With 0 or 1 participant there are no possible pairs.
    if (unique.length < 2) return null;

    const objectIds = unique.map((id) => new Types.ObjectId(id));
    const row = await UserBlock.findOne({
        blocker: { $in: objectIds },
        blocked: { $in: objectIds },
    })
        .select('blocker blocked')
        .lean();

    if (!row) return null;
    return {
        blocker: row.blocker?.toString(),
        blocked: row.blocked?.toString(),
    };
};

const blockUser = async (blockerId: string, blockedId: string) => {
    if (blockerId === blockedId) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'You can not block yourself'
        );
    }
    if (!mongoose.Types.ObjectId.isValid(blockedId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid user id');
    }
    const target = await NormalUser.findById(blockedId).select('_id');
    if (!target) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    try {
        const result = await UserBlock.create({
            blocker: blockerId,
            blocked: blockedId,
        });
        return result;
    } catch (error: unknown) {
        // Already blocked (unique index): idempotent, not an error.
        if ((error as { code?: number })?.code === 11000) {
            return await UserBlock.findOne({
                blocker: blockerId,
                blocked: blockedId,
            });
        }
        throw error;
    }
};

const unblockUser = async (blockerId: string, blockedId: string) => {
    const result = await UserBlock.findOneAndDelete({
        blocker: blockerId,
        blocked: blockedId,
    });
    if (!result) {
        throw new AppError(
            httpStatus.NOT_FOUND,
            'This user is not in your block list'
        );
    }
    return result;
};

const getMyBlockedUsers = async (
    blockerId: string,
    query: Record<string, unknown>
) => {
    const blockQuery = new QueryBuilder(
        UserBlock.find({ blocker: blockerId }).populate({
            path: 'blocked',
            // No `email`: blocking is open to any authenticated user, so reading this
            // list leaked mails; name and photo are enough to recognize someone.
            select: 'name profile_image',
        }),
        query
    )
        .filter()
        .sort()
        .paginate()
        .fields();

    const result = await blockQuery.modelQuery;
    const meta = await blockQuery.countTotal();
    return { meta, result };
};

const userBlockServices = {
    getBlockedIdsFor,
    getBlockedObjectIdsFor,
    findBlockedPairAmong,
    blockUser,
    unblockUser,
    getMyBlockedUsers,
};

export default userBlockServices;
