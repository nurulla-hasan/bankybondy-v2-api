/* eslint-disable @typescript-eslint/no-explicit-any */
/* Sweep de moderacion de audios: RED DE SEGURIDAD de durabilidad.
 *
 * El analisis de un audio corre en segundo plano dentro del proceso (fire-and-
 * forget desde el controller). Si el proceso se reinicia JUSTO mientras analiza,
 * ese audio puede quedar clavado en estado 'processing' para siempre.
 *
 * Este barrido periodico busca audios que llevan demasiado tiempo en 'processing'
 * (mas que cualquier analisis normal) y les vuelve a correr la MISMA moderacion
 * existente (processAudioModeration), que los deja en ready/rejected/failed.
 *
 * NO toca el flujo de subida ni el analizador: es puramente aditivo. Corre solo
 * en el proceso worker (worker.ts), no en la API, para no duplicar trabajo.
 */
import cron from 'node-cron';
import { expresionCron } from '../../utilities/expresionCron';
import { errorLogger, logger } from '../../shared/logger';
import { ENUM_AUDIO_MODERATION_STATUS } from './audio.interface';
import Audio from './audio.model';
import AudioService from './audio.service';

const SWEEP_ENABLED =
    (process.env.AUDIO_SWEEP_ENABLED ?? 'true').toLowerCase() === 'true';
// Cada 5 minutos por defecto.
const SWEEP_CRON = expresionCron('AUDIO_SWEEP_CRON', '*/5 * * * *');
// Lote chico: cada reproceso es una llamada pesada (ffmpeg + 2x OpenAI).
const SWEEP_BATCH = Number(process.env.AUDIO_SWEEP_BATCH) || 5;
// Umbral holgado: solo audios en 'processing' hace mas de N minutos (mayor que
// lo que tarda un analisis normal), para NUNCA agarrar uno que sigue en curso.
const STUCK_MINUTES = Number(process.env.AUDIO_STUCK_MINUTES) || 10;
// EC2 (Tanda 0): reintento de audios `failed` (fallo TÉCNICO, no de contenido).
// Tope de intentos para no reintentar para siempre + backoff (solo failed cuyo
// updatedAt sea más viejo que N minutos, para no martillar).
const FAILED_MAX_RETRIES = Number(process.env.AUDIO_FAILED_MAX_RETRIES) || 5;
const FAILED_RETRY_MINUTES =
    Number(process.env.AUDIO_FAILED_RETRY_MINUTES) || 30;

/** Reprocesa un lote de audios: clavados en 'processing' + `failed` con reintentos
 *  disponibles. Cada audio se RECLAMA de forma ATÓMICA (findOneAndUpdate) para que
 *  dos corridas solapadas del sweep NUNCA reprocesen el mismo (evita, p.ej., que uno
 *  lo borre de S3 mientras otro lo marca ready). Devuelve cuántos se reprocesaron. */
export const runAudioSweepOnce = async (): Promise<number> => {
    const now = Date.now();
    const stuckBefore = new Date(now - STUCK_MINUTES * 60 * 1000);
    const failedRetryBefore = new Date(now - FAILED_RETRY_MINUTES * 60 * 1000);

    let n = 0;

    // Pool 1: PROCESSING clavados. Reclamo = bump de updatedAt: saca el doc de la
    // ventana "clavado", así una corrida concurrente ya no lo selecciona.
    for (let i = 0; i < SWEEP_BATCH; i++) {
        // eslint-disable-next-line no-await-in-loop
        const claimed = await Audio.findOneAndUpdate(
            {
                moderationStatus: ENUM_AUDIO_MODERATION_STATUS.PROCESSING,
                updatedAt: { $lt: stuckBefore },
            },
            { $set: { updatedAt: new Date() } },
            { sort: { updatedAt: 1 }, new: true }
        ).select('_id audio_url');
        if (!claimed) break; // no quedan clavados
        if (!claimed.audio_url) continue;
        try {
            // eslint-disable-next-line no-await-in-loop
            await AudioService.processAudioModeration(
                claimed._id.toString(),
                claimed.audio_url
            );
        } catch (e) {
            errorLogger.error(
                '[audio] sweep reproceso (processing) falló:',
                (e as Error)?.message
            );
        }
        n++;
    }

    // Pool 2 (EC2): FAILED con reintentos disponibles. Es un fallo TÉCNICO (los
    // archivos S3 se conservan), NO un veredicto de contenido → se puede reintentar.
    // `rejected` NUNCA se toca (terminal por contenido). Reclamo ATÓMICO: se marca
    // PROCESSING + $inc del intento en un solo findOneAndUpdate (así una corrida
    // concurrente ya no lo agarra, y el intento se cuenta). El `$exists:false`
    // incluye el backlog VIEJO (audios `failed` de antes del campo `moderationAttempts`:
    // el `$lt` solo no matchea documentos sin el campo). Tope + backoff para converger.
    const remaining = Math.max(0, SWEEP_BATCH - n);
    for (let i = 0; i < remaining; i++) {
        // eslint-disable-next-line no-await-in-loop
        const claimed = await Audio.findOneAndUpdate(
            {
                moderationStatus: ENUM_AUDIO_MODERATION_STATUS.FAILED,
                $or: [
                    { moderationAttempts: { $lt: FAILED_MAX_RETRIES } },
                    { moderationAttempts: { $exists: false } },
                ],
                updatedAt: { $lt: failedRetryBefore },
            },
            {
                $inc: { moderationAttempts: 1 },
                $set: {
                    moderationStatus:
                        ENUM_AUDIO_MODERATION_STATUS.PROCESSING,
                },
            },
            { sort: { updatedAt: 1 }, new: true }
        ).select('_id audio_url');
        if (!claimed) break; // no quedan failed reintentables
        if (!claimed.audio_url) continue;
        try {
            // eslint-disable-next-line no-await-in-loop
            await AudioService.processAudioModeration(
                claimed._id.toString(),
                claimed.audio_url
            );
        } catch (e) {
            errorLogger.error(
                '[audio] sweep reintento (failed) falló:',
                (e as Error)?.message
            );
        }
        n++;
    }
    return n;
};

let scheduled = false;
// Anti-solape: node-cron NO espera a que termine una corrida antes de disparar la
// siguiente. Si un reproceso (ffmpeg + 2×OpenAI) se demora más que el intervalo,
// dos corridas se solaparían. Este flag evita arrancar otra si la anterior sigue.
let running = false;
/** Registra el cron del sweep de audios (idempotente). Llamar al arrancar. */
export const startAudioSweep = (): void => {
    if (!SWEEP_ENABLED) {
        logger.info(
            '[audio] sweep de moderacion deshabilitado (AUDIO_SWEEP_ENABLED=false).'
        );
        return;
    }
    if (scheduled) return;
    scheduled = true;
    cron.schedule(SWEEP_CRON, async () => {
        if (running) return; // la corrida anterior sigue: no solapar
        running = true;
        try {
            const n = await runAudioSweepOnce();
            if (n) {
                logger.info(
                    `[audio] sweep reproceso ${n} audio(s) (processing clavados + failed con reintento).`
                );
            }
        } catch (e) {
            errorLogger.error(
                '[audio] sweep de moderacion fallo:',
                (e as Error)?.message
            );
        } finally {
            running = false;
        }
    });
    logger.info(
        `[audio] sweep de moderacion activo (${SWEEP_CRON}, lote ${SWEEP_BATCH}, umbral ${STUCK_MINUTES}m).`
    );
};
