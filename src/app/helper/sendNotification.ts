import { INotification } from '../modules/notification/notification.interface';
import Notification from '../modules/notification/notification.model';
import { getIO } from '../socket/socket';
import getUserNotificationCount from './getUserNotificationCount';

interface SendNotificationOptions {
    // Keep one notification per (receiver + type + redirectId), refreshing text,
    // bumping createdAt and marking it unread/visible. Used by match notifications.
    collapseByRedirect?: boolean;
    // New match signatures for `notifiedSignatures` (MATCH collapse only); prevents
    // a reappearing signature from resetting seenBy again (badge anti-rebound).
    addSignatures?: string[];
}

const sendNotification = async (
    notificationData: INotification,
    options?: SendNotificationOptions
) => {
    // Collapse path (match): upsert by (receiver, type, redirectId). Falls back to
    // a plain create when redirectId is missing.
    if (options?.collapseByRedirect && notificationData.redirectId) {
        const { receiver, type, redirectId } = notificationData;
        const filter = { receiver, type, redirectId };
        const now = new Date();
        // timestamps:false so we control createdAt/updatedAt: bumping createdAt
        // reorders the listing (desc) without Mongoose overriding our $set.
        const update: Record<string, unknown> = {
            $set: {
                title: notificationData.title,
                message: notificationData.message,
                seenBy: [],
                deleteBy: [],
                createdAt: now,
                updatedAt: now,
            },
        };
        // Record the genuinely new signatures being notified (caller only calls
        // when there are new ones) so a later reappearance won't bounce the badge.
        const sigs = options?.addSignatures;
        if (sigs && sigs.length) {
            // $slice caps the array at the last N signatures so an active bond
            // doesn't grow thousands; dropping an old one may re-notify once.
            update.$push = { notifiedSignatures: { $each: sigs, $slice: -300 } };
        }
        try {
            await Notification.findOneAndUpdate(filter, update, {
                upsert: true,
                new: true,
                timestamps: false,
            });
        } catch (err: unknown) {
            // Partial unique index (receiver, redirectId | type=MATCH): concurrent
            // robot runs collide with 11000; the row exists, so update without upsert.
            if ((err as { code?: number })?.code === 11000) {
                await Notification.updateOne(filter, update, {
                    timestamps: false,
                });
            } else {
                throw err;
            }
        }
    } else {
        // Persist first so the notification survives when no socket exists: the
        // matching worker process never initializes `io`.
        await Notification.create(notificationData);
    }

    // Live push is best-effort; failures must never break the caller.
    try {
        const io = getIO();
        const updatedNotification = await getUserNotificationCount(
            notificationData.receiver.toString()
        );
        io.to(notificationData.receiver.toString()).emit(
            'notification',
            updatedNotification
        );
    } catch {
        /* no socket in this process: notification already persisted */
    }
};

export default sendNotification;
