/* eslint-disable @typescript-eslint/no-explicit-any */
/* Audio moderation sweep: durability safety net. A restart mid-analysis can leave
 * an audio stuck in 'processing' forever; the sweep re-runs the same moderation on
 * long-stuck docs, landing them in ready/rejected/failed. Additive only; runs in
 * the worker process, not the API. */
import cron from 'node-cron';
import { expresionCron } from '../../utilities/expresionCron';
import { errorLogger, logger } from '../../shared/logger';
import { ENUM_AUDIO_MODERATION_STATUS } from './audio.interface';
import Audio from './audio.model';
import AudioService from './audio.service';

const SWEEP_ENABLED =
    (process.env.AUDIO_SWEEP_ENABLED ?? 'true').toLowerCase() === 'true';
const SWEEP_CRON = expresionCron('AUDIO_SWEEP_CRON', '*/5 * * * *');
// Each reprocess is heavy (ffmpeg + 2x OpenAI): keep the batch small.
const SWEEP_BATCH = Number(process.env.AUDIO_SWEEP_BATCH) || 5;
// Generous threshold (longer than any normal analysis) so in-flight docs are never grabbed.
const STUCK_MINUTES = Number(process.env.AUDIO_STUCK_MINUTES) || 10;
// EC2: retry `failed` docs (technical, not content) with a cap + backoff so they converge.
const FAILED_MAX_RETRIES = Number(process.env.AUDIO_FAILED_MAX_RETRIES) || 5;
const FAILED_RETRY_MINUTES =
    Number(process.env.AUDIO_FAILED_RETRY_MINUTES) || 30;

/** Reprocesses one batch: stuck 'processing' + retryable `failed`. Each doc is
 *  claimed atomically (findOneAndUpdate) so overlapping runs never reprocess the
 *  same one (e.g. one deleting S3 while the other marks it ready). Returns count. */
export const runAudioSweepOnce = async (): Promise<number> => {
    const now = Date.now();
    const stuckBefore = new Date(now - STUCK_MINUTES * 60 * 1000);
    const failedRetryBefore = new Date(now - FAILED_RETRY_MINUTES * 60 * 1000);

    let n = 0;

    // Pool 1: stuck PROCESSING. Claim = bump updatedAt, which drops it out of the
    // stuck window so a concurrent run no longer selects it.
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
        if (!claimed) break; // no stuck docs left
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

    // Pool 2 (EC2): FAILED with retries left — a technical failure (S3 kept), so
    // retryable. `rejected` is terminal and never touched. Claim atomically: mark
    // PROCESSING + $inc the attempt in one call. `$exists:false` covers the old
    // backlog predating moderationAttempts (a bare `$lt` misses docs without it).
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
        if (!claimed) break; // no retryable failed docs left
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
// Overlap guard: node-cron doesn't wait for the previous run, and a slow reprocess
// (ffmpeg + 2x OpenAI) could overlap the next tick.
let running = false;
/** Registers the audio sweep cron (idempotent). Call at startup. */
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
        if (running) return; // previous run still going: don't overlap
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
