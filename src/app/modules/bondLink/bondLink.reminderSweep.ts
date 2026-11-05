/* eslint-disable @typescript-eslint/no-explicit-any */
/* Sweep de RECORDATORIO de cierre de trueques (Tanda 2, rating en suspenso).
 *
 * Como la reputación se aplica SOLO cuando todos marcan completado (sin válvula de
 * liberación), un trueque viejo Ongoing con reseñas en suspenso queda trabado. Este
 * barrido nudgea UNA sola vez (flag reminderSentAt) a los participantes que NO
 * cerraron un trueque Ongoing más viejo que N días, para que lo cierren y se
 * apliquen las reseñas de todos. Corre en el proceso WORKER, no en la API.
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
// Una vez por día (por defecto al mediodía).
const SWEEP_CRON = expresionCron('TRADE_REMINDER_CRON', '0 12 * * *');
// Antigüedad (días) del trueque Ongoing antes de recordar.
const REMINDER_DAYS = Number(process.env.TRADE_REMINDER_DAYS) || 5;
// Lote por corrida (para no saturar).
const SWEEP_BATCH = Number(process.env.TRADE_REMINDER_BATCH) || 100;

/** Nudgea a los que NO cerraron trueques Ongoing viejos. UNA vez por trueque
 *  (reminderSentAt). Devuelve cuántos trueques recordó. */
export const runReminderSweepOnce = async (): Promise<number> => {
    const cutoff = new Date(Date.now() - REMINDER_DAYS * 24 * 60 * 60 * 1000);
    // `reminderSentAt: null` matchea tanto null como el campo AUSENTE (docs viejos).
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
        // Reclamo ATÓMICO primero: solo la corrida que gana el update (reminderSentAt
        // aún null) manda los avisos → anti-doble-envío si dos corridas se solapan.
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

/** RED DE SEGURIDAD de durabilidad para el rating en suspenso. El batch-apply de
 *  markAsCompleteBond corre fuera de transacción: si el proceso muere entre la
 *  transición a Completed y el updateMany, las reseñas quedan `applied:false`
 *  sobre un trueque YA cerrado → subcontarían la reputación para siempre. Igual
 *  la race del upsert de addRating (leyó Ongoing justo antes del cierre) deja una
 *  reseña varada. Este barrido las promueve y recomputa. Devuelve cuántas aplicó. */
export const reconcileStrandedRatings = async (): Promise<number> => {
    // BondLinks con alguna reseña aún en suspenso...
    const strandedLinkIds = await BondRating.distinct('bondLink', {
        applied: { $ne: true },
    });
    if (!strandedLinkIds.length) return 0;
    // ...pero que YA están Completed (los Ongoing quedan en suspenso, es correcto).
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
/** Registra el cron del recordatorio + reconciliación (idempotente). Llamar al
 *  arrancar el worker. */
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
        if (running) return; // la corrida anterior sigue: no solapar
        running = true;
        try {
            // 1) Red de seguridad: rescatar reseñas varadas de trueques ya cerrados.
            const applied = await reconcileStrandedRatings();
            if (applied) {
                logger.info(
                    `[trueque] reconciliación: aplicadas ${applied} reseña(s) varada(s) de trueque(s) Completed.`
                );
            }
            // 2) Recordatorio a los que no cerraron trueques Ongoing viejos.
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
