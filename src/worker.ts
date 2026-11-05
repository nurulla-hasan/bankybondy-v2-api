/* eslint-disable no-undef */
/* Proceso DEDICADO del matcheo (worker).
 *
 * Motivo: el cómputo del matcheo es pesado (grafo O(N²), DFS de ciclos). Si
 * corre dentro del proceso de la API, bloquea el event loop y degrada la
 * latencia de TODAS las peticiones HTTP/sockets. Aquí lo aislamos: la API sólo
 * ENCOLA recomputos en Redis (BullMQ) y este proceso los CONSUME.
 *
 * Este entrypoint NO levanta HTTP/Express ni el servidor de sockets: sólo
 * conecta a Mongo y arranca el worker BullMQ + el sweep periódico de ciclos.
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
import { startMatchingSweep } from './app/modules/bondRequest/matching.sweep';
import { startAudioSweep } from './app/modules/audio/audio.sweep';
import { startTrendingSweep } from './app/modules/audio/trending.sweep';
import { startDigestCron } from './app/modules/notificationDigest/digest.cron';
import { startCompletionReminderSweep } from './app/modules/bondLink/bondLink.reminderSweep';

// Excepciones no capturadas: estado corrupto -> salir para que el
// supervisor (PM2) reinicie el proceso limpio.
process.on('uncaughtException', (error) => {
    errorLogger.error('[worker] Uncaught Exception:', error);
    process.exit(1);
});

// Rechazos de promesa no manejados: salir para reinicio limpio por PM2.
process.on('unhandledRejection', (error) => {
    errorLogger.error('[worker] Unhandled Rejection:', error);
    process.exit(1);
});

async function main() {
    try {
        // Mismo pool/timeouts que la API (server.ts) para consistencia operativa.
        await mongoose.connect(config.database_url as string, {
            maxPoolSize: 50,
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 45000,
        });
        logger.info('[worker] DB Connected Successfully');

        // EL CONSUMIDOR corre en TODAS las instancias: acá vive el paralelismo
        // real. BullMQ reparte los jobs entre todos los workers que escuchan la
        // cola, así que subir `instances` multiplica la capacidad de CÓMPUTO.
        // Sin Redis, queda en modo fallback (compute-on-miss inline).
        startMatchingWorker();

        // LOS PRODUCTORES corren en UNA sola instancia. Tres sweeps simultáneos
        // traen el MISMO lote (mismo filtro, mismo orden) y encolan lo mismo: la
        // deduplicación por `jobId` evita computar tres veces, pero la capacidad
        // no sube y se paga la consulta por triplicado. Ver utilities/instancia.ts.
        if (esInstanciaLider()) {
            startMatchingSweep();
            // Red de seguridad de durabilidad: reprocesa audios clavados en
            // 'processing' (p.ej. por un reinicio a mitad del analisis).
            startAudioSweep();
            // E1: recomputo periódico del "trending" (score sobre escuchas reales).
            startTrendingSweep();
            // Digest semanal por email (Fase 4). Inerte hasta DIGEST_ENABLED=true.
            startDigestCron();
            // Recordatorio de cerrar trueques Ongoing viejos (rating en suspenso):
            // para que se apliquen las reseñas hace falta que TODOS cierren.
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
        // No se pudo arrancar (p.ej. Mongo caído): abortar para reinicio limpio.
        process.exit(1);
    }
}

// Apagado graceful: cerrar worker/cola BullMQ y la conexión de Mongo.
const gracefulShutdown = async (signal: string) => {
    logger.info(`[worker] ${signal} received, shutting down gracefully`);
    try {
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
    // Salida forzada si el cierre se cuelga.
    setTimeout(() => process.exit(1), 10000).unref();
});
process.on('SIGINT', () => {
    void gracefulShutdown('SIGINT');
    setTimeout(() => process.exit(1), 10000).unref();
});

main();
