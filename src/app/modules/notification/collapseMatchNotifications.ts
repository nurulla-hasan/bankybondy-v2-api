/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Idempotent match-notification migration (runs once at boot, fire-and-forget):
 * 1) collapse duplicate MATCH rows by (receiver, redirectId), keeping the newest;
 * 2) then create the PARTIAL UNIQUE index (receiver, redirectId | type=MATCH).
 * Errors are logged; boot is never aborted.
 */
import { errorLogger, logger } from '../../shared/logger';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';
import Notification from './notification.model';

let alreadyRan = false;

export const collapseMatchNotifications = async (): Promise<void> => {
    if (alreadyRan) return;
    alreadyRan = true;

    const coll = Notification.collection;

    // --- Step 1: collapse existing duplicates ---
    // Sort by createdAt desc BEFORE $group: $push keeps that order, so ids[0] is
    // the newest one (the one kept).
    const groups = await coll
        .aggregate(
            [
                {
                    $match: {
                        type: ENUM_NOTIFICATION_TYPE.MATCH,
                        redirectId: { $ne: null },
                    },
                },
                { $sort: { createdAt: -1 } },
                {
                    $group: {
                        _id: {
                            receiver: '$receiver',
                            redirectId: '$redirectId',
                        },
                        ids: { $push: '$_id' },
                    },
                },
                { $match: { $expr: { $gt: [{ $size: '$ids' }, 1] } } },
            ],
            { allowDiskUse: true }
        )
        .toArray();

    const toDelete: any[] = [];
    for (const g of groups as any[]) {
        // Keep ids[0] (newest); delete the rest.
        for (let i = 1; i < g.ids.length; i++) toDelete.push(g.ids[i]);
    }

    if (toDelete.length) {
        const res = await coll.deleteMany({ _id: { $in: toDelete } });
        logger.info(
            `[migration] Notificaciones MATCH colapsadas: ${res.deletedCount} duplicadas borradas en ${groups.length} vínculos.`
        );
    }

    // --- Step 2: partial unique index (one MATCH per trade) ---
    try {
        await coll.createIndex(
            { receiver: 1, redirectId: 1 },
            {
                unique: true,
                partialFilterExpression: {
                    type: ENUM_NOTIFICATION_TYPE.MATCH,
                },
                name: 'uniq_match_notif_per_vinculo',
            }
        );
    } catch (err) {
        // Does not abort boot: without the index, the sendNotification upsert
        // still collapses in practice (the robot serializes per bond).
        errorLogger.error(
            '[migration] createIndex uniq_match_notif_per_vinculo falló:',
            (err as Error)?.message
        );
    }
};

export default collapseMatchNotifications;
