import mongoose from 'mongoose';
import Notification from '../modules/notification/notification.model';
import NormalUser from '../modules/normalUser/normalUser.model';
import { mutedTypesFromCategories } from '../modules/notification/notification.categories';
import { getBlockedIdsFor } from '../modules/userBlock/userBlock.service';

const getUserNotificationCount = async (receiver: string) => {
    // Muted categories still get created; they are only excluded from the
    // unseen count (same filter as the list in getAllNotificationFromDB).
    let mutedTypes: string[] = [];
    if (mongoose.Types.ObjectId.isValid(receiver)) {
        const me = await NormalUser.findById(receiver)
            .select('mutedNotificationCategories')
            .lean();
        mutedTypes = mutedTypesFromCategories(
            (me as any)?.mutedNotificationCategories
        );
    }

    // Derived from `seenBy` (the schema has no `seen` field). Filters must match
    // the listing so the badge never exceeds the visible items.
    const blockedIds = mongoose.Types.ObjectId.isValid(receiver)
        ? await getBlockedIdsFor(receiver)
        : [];
    const filter: Record<string, any> = {
        // Include broadcasts (receiver:'all') like the listing and mark-seen.
        $or: [{ receiver }, { receiver: 'all' }],
        seenBy: { $ne: new mongoose.Types.ObjectId(receiver) },
        deleteBy: { $ne: new mongoose.Types.ObjectId(receiver) },
        redirectId: { $nin: blockedIds },
    };
    if (mutedTypes.length) {
        filter.type = { $nin: mutedTypes };
    }

    const unseenCount = await Notification.countDocuments(filter);
    const latestFilter: Record<string, any> = {
        $or: [{ receiver }, { receiver: 'all' }],
        deleteBy: { $ne: new mongoose.Types.ObjectId(receiver) },
        redirectId: { $nin: blockedIds },
    };
    if (mutedTypes.length) {
        latestFilter.type = { $nin: mutedTypes };
    }
    const latestRaw = await Notification.findOne(latestFilter)
        .select({ deleteBy: 0, notifiedSignatures: 0 })
        .sort({ createdAt: -1 })
        .lean();
    const latestNotification = latestRaw
        ? (() => {
              const { seenBy = [], ...item } = latestRaw as any;
              return {
                  ...item,
                  seen: (seenBy as any[]).some(
                      (id) => String(id) === String(receiver)
                  ),
              };
          })()
        : null;
    return { unseenCount, latestNotification };
};

export default getUserNotificationCount;
