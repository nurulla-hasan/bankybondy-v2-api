/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { JwtPayload } from 'jsonwebtoken';
import { USER_ROLE } from '../user/user.constant';
import QueryBuilder from '../../builder/QueryBuilder';
import Notification from './notification.model';
import AppError from '../../error/appError';
import httpStatus from 'http-status';
import getUserNotificationCount from '../../helper/getUserNotificationCount';
import NormalUser from '../normalUser/normalUser.model';
import { getBlockedIdsFor } from '../userBlock/userBlock.service';
import {
    NOTIFICATION_CATEGORIES,
    mutedTypesFromCategories,
    sanitizeCategories,
} from './notification.categories';
// import getAdminNotificationCount from '../../helper/getAdminNotification';
// import getUnseenNotificationCount from '../../helper/getUnseenNotification';

const getAllNotificationFromDB = async (
    query: Record<string, any>,
    user: JwtPayload
) => {
    if (user?.role === USER_ROLE.superAdmin) {
        const notificationQuery = new QueryBuilder(
            Notification.find({ receiver: USER_ROLE.superAdmin }),
            query
        )
            .search(['name'])
            .filter()
            .sort()
            .paginate()
            .fields();
        const result = await notificationQuery.modelQuery;
        const meta = await notificationQuery.countTotal();
        return { meta, result };
    } else {
        // Hide notifications whose actor (redirectId, a string) is blocked either way.
        // `$nin` keeps docs with null/absent redirectId (system notifications).
        const blockedIds = await getBlockedIdsFor(String(user.profileId));
        // Muted categories are neither shown nor counted, same rule as the count helper
        // (getUserNotificationCount), so list and badge stay aligned.
        const me = await NormalUser.findById(user.profileId)
            .select('mutedNotificationCategories')
            .lean();
        const mutedTypes = mutedTypesFromCategories(
            (me as any)?.mutedNotificationCategories
        );
        const baseFilter: Record<string, any> = {
            $or: [{ receiver: user.profileId }, { receiver: 'all' }],
            deleteBy: { $ne: user.profileId },
            redirectId: { $nin: blockedIds },
        };
        if (mutedTypes.length) baseFilter.type = { $nin: mutedTypes };
        const notificationQuery = new QueryBuilder(
            Notification.find(baseFilter).select({
                deleteBy: 0,
                notifiedSignatures: 0,
            }),
            query
        )
            .search(['name'])
            .filter()
            .sort()
            .paginate()
            .fields();
        const docs = await notificationQuery.modelQuery;
        const meId = String(user.profileId);
        // Read state is per-user: expose a `seen` boolean and never the whole
        // `seenBy` array (it would leak every reader's profile id).
        const result = (Array.isArray(docs) ? docs : []).map((doc: any) => {
            const item =
                typeof doc?.toObject === 'function' ? doc.toObject() : doc;
            const seenBy = Array.isArray(item?.seenBy) ? item.seenBy : [];
            delete item.seenBy;

            return {
                ...item,
                seen: seenBy.some((id: any) => String(id) === meId),
            };
        });
        const meta = await notificationQuery.countTotal();
        return { meta, result };
    }
};

// Unseen count (+ latest) for the user. Uses the SAME helper as the socket
// (getUserNotificationCount) so the initial number and the live 'notification' event agree.
const getUnseenCount = async (user: JwtPayload) => {
    return getUserNotificationCount(String(user?.profileId));
};

const seeNotification = async (user: JwtPayload) => {
    let result;
    if (user?.role === USER_ROLE.superAdmin) {
        // Admin: mark seen by adding profileId to `seenBy` (the schema has no `seen`
        // field; writing to it silently recorded nothing).
        result = await Notification.updateMany(
            { $or: [{ receiver: USER_ROLE.superAdmin }, { receiver: 'all' }] },
            { $addToSet: { seenBy: user?.profileId } },
            { runValidators: true }
        );
        // const adminUnseenNotificationCount = await getAdminNotificationCount();
        //@ts-ignore
        // global.io.emit('admin-notifications', adminUnseenNotificationCount);
    } else {
        result = await Notification.updateMany(
            { $or: [{ receiver: user?.profileId }, { receiver: 'all' }] },
            { $addToSet: { seenBy: user?.profileId } },
            { runValidators: true }
        );
    }
    //   const updatedNotificationCount = await getUnseenNotificationCount(
    //     user?.userId,
    //   );
    //@ts-ignore
    //   global.io.to(user?.userId).emit('notifications', updatedNotificationCount);
    return result;
};

// Marks ONE notification as seen (adds profileId to `seenBy`). Used when the user
// OPENS a specific notification, so the badge drops only for the ones actually opened.
const seeOneNotification = async (user: JwtPayload, id: string) => {
    const receiverKey =
        user?.role === USER_ROLE.superAdmin
            ? USER_ROLE.superAdmin
            : user?.profileId;
    return Notification.updateOne(
        { _id: id, $or: [{ receiver: receiverKey }, { receiver: 'all' }] },
        { $addToSet: { seenBy: user?.profileId } },
        { runValidators: true }
    );
};

const deleteNoficiation = async (id: string, profileId: string) => {
    const notification = await Notification.findOne({ _id: id, $or: [{ receiver: 'all' }, { receiver: profileId }] });
    if (!notification) {
        throw new AppError(httpStatus.NOT_FOUND, 'Notification not found');
    }
    if (notification.receiver == profileId) {
        await Notification.findByIdAndDelete(id);
        return null;
    } else {
        await Notification.findByIdAndUpdate(id, {
            $addToSet: { deleteBy: profileId },
        });
        return null;
    }
};

// Mute preferences: the user's muted categories plus the valid category list
// (so the front can draw the toggles).
const getPreferences = async (user: JwtPayload) => {
    const me = await NormalUser.findById(user?.profileId)
        .select('mutedNotificationCategories')
        .lean();
    return {
        mutedCategories:
            (me as any)?.mutedNotificationCategories ?? ([] as string[]),
        categories: NOTIFICATION_CATEGORIES,
    };
};

// Saves the full muted-category set (the front sends the final state); sanitized
// against the valid list, so any odd value is dropped.
const updatePreferences = async (user: JwtPayload, mutedCategories: unknown) => {
    // F3.4: reject a malformed body instead of WIPING all mutes. A non-array body used
    // to fall back to [] in sanitizeCategories and silently erase every muted category.
    if (!Array.isArray(mutedCategories)) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'mutedCategories debe ser un array.'
        );
    }
    const clean = sanitizeCategories(mutedCategories);
    const updated = await NormalUser.findByIdAndUpdate(
        user?.profileId,
        { $set: { mutedNotificationCategories: clean } },
        { new: true }
    )
        .select('mutedNotificationCategories')
        .lean();
    return {
        mutedCategories:
            (updated as any)?.mutedNotificationCategories ?? ([] as string[]),
    };
};

const notificationService = {
    getAllNotificationFromDB,
    getUnseenCount,
    seeNotification,
    seeOneNotification,
    deleteNoficiation,
    getPreferences,
    updatePreferences,
};

export default notificationService;
