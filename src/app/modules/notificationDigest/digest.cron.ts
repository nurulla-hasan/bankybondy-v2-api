import cron from 'node-cron';
import { errorLogger, logger } from '../../shared/logger';
import { sendWeeklyDigests } from './digest.service';

// Lunes 10:00 HORA ARGENTINA. node-cron usa la hora del SERVER, que corre en
// UTC (UTC-3 respecto de AR), por eso la expresión dice 13 y no 10: con '0 10'
// el mail salía 07:00 AR. Configurable por env.
const DIGEST_CRON = process.env.DIGEST_CRON || '0 13 * * 1';
const DIGEST_ENABLED = process.env.DIGEST_ENABLED === 'true';

let scheduled = false;

/** Registra el cron del digest semanal (idempotente). Se llama al arrancar el
 *  worker. Si DIGEST_ENABLED != true, NO agenda nada (queda inerte). */
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
