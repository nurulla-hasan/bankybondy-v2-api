import cron from 'node-cron';
import { errorLogger, logger } from '../../shared/logger';
import { sendWeeklyDigests } from './digest.service';

// Monday 10:00 Argentina time. node-cron uses SERVER time (UTC), hence 13 and not 10:
// with '0 10' the mail left at 07:00 AR. Env-configurable.
const DIGEST_CRON = process.env.DIGEST_CRON || '0 13 * * 1';
const DIGEST_ENABLED = process.env.DIGEST_ENABLED === 'true';

let scheduled = false;

/** Registers the weekly digest cron (idempotent), called on worker start. Schedules
 *  nothing unless DIGEST_ENABLED is true. */
export const startDigestCron = (): void => {
    if (!DIGEST_ENABLED) {
        logger.info(
            '[digest] cron deshabilitado (DIGEST_ENABLED != true). No se agenda.'
        );
        return;
    }
    if (scheduled) return;
    if (!cron.validate(DIGEST_CRON)) {
        errorLogger.error(`[digest] DIGEST_CRON inválido: "${DIGEST_CRON}"`);
        return;
    }
    scheduled = true;
    cron.schedule(DIGEST_CRON, async () => {
        try {
            logger.info('[digest] corriendo digest semanal…');
            await sendWeeklyDigests();
        } catch (e) {
            errorLogger.error(
                '[digest] el cron falló:',
                (e as Error)?.message
            );
        }
    });
    logger.info(`[digest] cron semanal agendado (${DIGEST_CRON}).`);
};

export default startDigestCron;
