/* eslint-disable @typescript-eslint/no-explicit-any */
/* Trade-closure reminder sweep. Reputation only applies once everyone marks
 * completed, so old Ongoing trades stay stuck. This nudges non-completers ONCE
 * (reminderSentAt). Runs in the WORKER process, not the API.
 */
import cron from 'node-cron';
import { expresionCron } from '../../utilities/expresionCron';
import { errorLogger, logger } from '../../shared/logger';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';
import sendNotification from '../../helper/sendNotification';
import { ENUM_BOND_LINK_STATUS } from './bondLink.enum';
import { BondLink } from './bondLink.model';
import BondRating from '../bondRating/bondRating.model';
import { recomputeReputation } from '../bondRating/reputation.util';

const SWEEP_ENABLED =
    (process.env.TRADE_REMINDER_ENABLED ?? 'true').toLowerCase() === 'true';
// Once per day (noon by default).
const SWEEP_CRON = expresionCron('TRADE_REMINDER_CRON', '0 12 * * *');
// Age (days) of an Ongoing trade before reminding.
const REMINDER_DAYS = Number(process.env.TRADE_REMINDER_DAYS) || 5;
// Batch per run, to avoid saturating.
const SWEEP_BATCH = Number(process.env.TRADE_REMINDER_BATCH) || 100;

/** Nudges non-completers of old Ongoing trades, once per trade (reminderSentAt).
 *  Returns how many trades were reminded. */
export const runReminderSweepOnce = async (): Promise<number> => {
    const cutoff = new Date(Date.now() - REMINDER_DAYS * 24 * 60 * 60 * 1000);
    // `reminderSentAt: null` also matches docs where the field is missing.
    const stale = await BondLink.find({
        status: ENUM_BOND_LINK_STATUS.Ongoing,
        createdAt: { $lt: cutoff },
        reminderSentAt: null,
    })
        .select('_id participants markAsCompletedBy')
        .limit(SWEEP_BATCH)
        .lean();

    let n = 0;
    for (const bl of stale as any[]) {
        // Atomic claim first: only the winning run sends, avoiding double-send
        // when two runs overlap.
        // eslint-disable-next-line no-await-in-loop
        const claimed = await BondLink.findOneAndUpdate(
            { _id: bl._id, reminderSentAt: null },
            { $set: { reminderSentAt: new Date() } }
        );
        if (!claimed) continue;

        const completed = new Set(
            (bl.markAsCompletedBy ?? []).map((x: any) => x.toString())
        );
        const nonCompleters = (bl.participants ?? [])
            .map((p: any) => p.toString())
            .filter((p: string) => !completed.has(p));

        for (const uid of nonCompleters) {
            // eslint-disable-next-line no-await-in-loop
            await sendNotification({
                title: 'Te falta cerrar un trueque',
                message:
                    'Marcá el trueque como completado para que se carguen las reseñas de todos.',
                receiver: uid,
                type: ENUM_NOTIFICATION_TYPE.TRADE_REMINDER,
                redirectId: bl._id.toString(),
            }).catch(() => undefined);
        }
        n++;
    }
    return n;
};

/** Durability safety net for suspended ratings. markAsCompleteBond's batch-apply
 *  runs outside a transaction, and addRating's upsert race can strand a rating.
 *  This promotes them and recomputes. Returns how many it applied. */
export const reconcileStrandedRatings = async (): Promise<number> => {
    // Trades with at least one still-suspended rating...
    const strandedLinkIds = await BondRating.distinct('bondLink', {
        applied: { $ne: true },
    });
    if (!strandedLinkIds.length) return 0;
    // ...that are already Completed (Ongoing ones correctly stay suspended).
    const completed = await BondLink.find({
        _id: { $in: strandedLinkIds },
        status: ENUM_BOND_LINK_STATUS.Completed,
    })
        .select('_id')
        .lean();

    let n = 0;
    for (const bl of completed as any[]) {
        // eslint-disable-next-line no-await-in-loop
        const res = await BondRating.updateMany(
            { bondLink: bl._id, applied: { $ne: true } },
            { $set: { applied: true } }
        );
        if (!res.modifiedCount) continue;
        // eslint-disable-next-line no-await-in-loop
        const ratedIds: any[] = await BondRating.distinct('rated', {
            bondLink: bl._id,
        });
        // eslint-disable-next-line no-await-in-loop
        await Promise.all(
            ratedIds.map((rid) =>
                recomputeReputation(rid.toString()).catch(() => undefined)
            )
        );
        n += res.modifiedCount;
    }
    return n;
};

let scheduled = false;
let running = false;
/** Registers the reminder + reconciliation cron (idempotent). Call on worker start. */
export const startCompletionReminderSweep = (): void => {
    if (!SWEEP_ENABLED) {
        logger.info(
            '[trueque] recordatorio de cierre deshabilitado (TRADE_REMINDER_ENABLED=false).'
        );
        return;
    }
    if (scheduled) return;
    scheduled = true;
    cron.schedule(SWEEP_CRON, async () => {
        if (running) return; // previous run still going: do not overlap
        running = true;
        try {
            // 1) Safety net: rescue stranded ratings of already closed trades.
            const applied = await reconcileStrandedRatings();
            if (applied) {
                logger.info(
                    `[trueque] reconciliación: aplicadas ${applied} reseña(s) varada(s) de trueque(s) Completed.`
                );
            }
            // 2) Remind those who did not close old Ongoing trades.
            const n = await runReminderSweepOnce();
            if (n) {
                logger.info(
                    `[trueque] recordatorio: nudgeados ${n} trueque(s) Ongoing viejo(s).`
                );
            }
        } catch (e) {
            errorLogger.error(
                '[trueque] sweep de recordatorio/reconciliación falló:',
                (e as Error)?.message
            );
        } finally {
            running = false;
        }
    });
    logger.info(
        `[trueque] recordatorio + reconciliación de cierre activos (${SWEEP_CRON}, ${REMINDER_DAYS}d).`
    );
};

export default startCompletionReminderSweep;
