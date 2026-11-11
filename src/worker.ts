/* eslint-disable no-undef */
/* DEDICATED matching (worker) process. Matching is heavy (O(N²) graph, cycle DFS)
 * and would block the event loop of the API, so the API only ENQUEUES recomputes
 * in Redis (BullMQ) and this process CONSUMES them. No HTTP/Express or socket
 * server here: only Mongo + the BullMQ worker + periodic sweeps.
 */
import mongoose from 'mongoose';
import config from './app/config';
import { errorLogger, logger } from './app/shared/logger';
import {
    esInstanciaLider,
    etiquetaInstancia,
} from './app/utilities/instancia';
import {
    closeMatchingRobot,
    startMatchingWorker,
} from './app/modules/bondRequest/matching.robot';
import { startMatchingSweep, stopMatchingSweep } from './app/modules/bondRequest/matching.sweep';
import { getMatchingSettings } from './app/modules/settings/matchingSettings.service';
import { startAudioSweep } from './app/modules/audio/audio.sweep';
import { startTrendingSweep } from './app/modules/audio/trending.sweep';
import { startDigestCron } from './app/modules/notificationDigest/digest.cron';
import { startCompletionReminderSweep } from './app/modules/bondLink/bondLink.reminderSweep';

// Uncaught exceptions: corrupt state -> exit so PM2 restarts a clean process.
process.on('uncaughtException', (error) => {
    errorLogger.error('[worker] Uncaught Exception:', error);
    process.exit(1);
});

// Unhandled promise rejections: exit for a clean PM2 restart.
process.on('unhandledRejection', (error) => {
    errorLogger.error('[worker] Unhandled Rejection:', error);
    process.exit(1);
});

async function main() {
    try {
        // Same pool/timeouts as the API (server.ts) for operational consistency.
        await mongoose.connect(config.database_url as string, {
            maxPoolSize: 50,
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 45000,
        });
        logger.info('[worker] DB Connected Successfully');

        // API owns initialization. Missing settings must fail startup before any
        // jobs are consumed; never seed from this worker's environment defaults.
        await getMatchingSettings(true);

        // THE CONSUMER runs on ALL instances: real parallelism lives here. BullMQ
        // spreads jobs across every worker listening on the queue, so raising
        // `instances` multiplies COMPUTE capacity. Without Redis it falls back to
        // inline compute-on-miss.
        startMatchingWorker();

        // PRODUCERS run on ONE instance only. Three simultaneous sweeps fetch the
        // SAME batch (same filter, same order) and enqueue the same work: `jobId`
        // dedupe avoids computing thrice, but capacity does not rise and the query
        // is paid three times. See utilities/instancia.ts.
        if (esInstanciaLider()) {
            await startMatchingSweep();
            // Durability safety net: reprocesses audios stuck in 'processing'
            // (e.g. a restart mid-analysis).
            startAudioSweep();
            // Periodic recompute of "trending" (score over real listens).
            startTrendingSweep();
            // Weekly email digest. Inert until DIGEST_ENABLED=true.
            startDigestCron();
            // Reminder to close old Ongoing trades (rating on hold): reviews only
            // apply once EVERYONE closes.
            startCompletionReminderSweep();
        } else {
            logger.info(
                `[worker ${etiquetaInstancia()}] instancia secundaria: consume la cola, no corre los cron.`
            );
        }
        logger.info(
            `[worker ${etiquetaInstancia()}] Matching worker process started`
        );
    } catch (error) {
        errorLogger.error('[worker] Error in main function:', error);
        // Could not start (e.g. Mongo down): abort for a clean restart.
        process.exit(1);
    }
}

// Graceful shutdown: close the BullMQ worker/queue and the Mongo connection.
const gracefulShutdown = async (signal: string) => {
    logger.info(`[worker] ${signal} received, shutting down gracefully`);
    try {
        stopMatchingSweep();
        await closeMatchingRobot();
        await mongoose.connection.close();
        logger.info('[worker] Matching robot & DB connections closed');
    } catch (err) {
        errorLogger.error('[worker] Error closing connections:', err);
    }
    process.exit(0);
};

process.on('SIGTERM', () => {
    void gracefulShutdown('SIGTERM');
    // Force exit if shutdown hangs.
    setTimeout(() => process.exit(1), 10000).unref();
});
process.on('SIGINT', () => {
    void gracefulShutdown('SIGINT');
    setTimeout(() => process.exit(1), 10000).unref();
});

main();
