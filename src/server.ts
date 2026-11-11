/* eslint-disable no-undef */
import { Server as HTTPServer } from 'http';
import mongoose from 'mongoose';
import server from './app';
import config from './app/config';
import seedSuperAdmin from './app/DB';
import { collapseMatchNotifications } from './app/modules/notification/collapseMatchNotifications';
import { bumpFreeBondLimit } from './app/modules/normalUser/bumpFreeBondLimit';
import { applyExistingRatings } from './app/modules/bondRating/applyExistingRatings';
import { backfillAgendaMatcheo } from './app/modules/bondRequest/backfillAgendaMatcheo';
import { reconciliarVinculosVivos } from './app/modules/normalUser/vinculosVivos';
import { errorLogger, logger } from './app/shared/logger';
import { getIO, initializeSocket } from './app/socket/socket';
import { closePresence } from './app/socket/presence';
import { closeMatchingRobot } from './app/modules/bondRequest/matching.robot';
import { initializeMatchingSettings } from './app/modules/settings/matchingSettings.service';
import {
    esInstanciaLider,
    etiquetaInstancia,
} from './app/utilities/instancia';

let myServer: HTTPServer | undefined;

// ───────────────────────────────────────────────────────────────────────────
// Helpers so death paths leave a trace.
//
// `logSeguro`: logging must never throw (winston's Object.assign on meta runs
// before any format). `salirDejandoRastro`: winston writes async, so an exit in
// the same tick swallows the log that explains why we exited.
// ───────────────────────────────────────────────────────────────────────────
const logSeguro = (mensaje: string, error?: unknown) => {
    try {
        errorLogger.error(mensaje, error);
    } catch {
        // Last resort: raw console, bypassing winston.
        // eslint-disable-next-line no-console
        console.error(mensaje, (error as Error)?.stack || error);
    }
};

const salirDejandoRastro = (codigo: number) => {
    setTimeout(() => process.exit(codigo), 100).unref();
};

// Uncaught exception: state may be corrupt -> exit so the supervisor (PM2)
// restarts a clean process.
process.on('uncaughtException', (error) => {
    logSeguro('Uncaught Exception:', error);
    salirDejandoRastro(1);
});

async function main() {
    try {
        await mongoose.connect(config.database_url as string, {
            maxPoolSize: 50,
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 45000,
        });
        logger.info('DB Connected Successfully');
        await initializeMatchingSettings();

        // Config warning: Google login verifies the idToken against
        // GOOGLE_CLIENT_ID; if missing it fails at runtime. Boot continues, but
        // the error is visible in PM2 logs.
        if (!process.env.GOOGLE_CLIENT_ID) {
            errorLogger.error(
                '[boot] GOOGLE_CLIENT_ID ausente: el login con Google va a fallar. Setear en el .env.'
            );
        }

        const port =
            typeof config.port === 'number' ? config.port : Number(config.port);

        myServer = server.listen(port, '0.0.0.0', () => {
            logger.info(
                `Server ${etiquetaInstancia()} running on http://0.0.0.0:${port}`
            );

            // HORIZONTAL SCALE: migrations and seeding run on one instance only.
            // All are idempotent, but no reason to pay for them N times.
            // See utilities/instancia.ts.
            if (!esInstanciaLider()) {
                logger.info(
                    `[boot ${etiquetaInstancia()}] instancia secundaria: sirve tráfico, no corre migraciones.`
                );
                return;
            }

            seedSuperAdmin().catch((err) =>
                errorLogger.error(
                    'seedSuperAdmin fallo:',
                    (err as Error)?.message
                )
            );
            // Idempotent migration: collapse duplicate MATCH notifications and
            // create the unique index. Fire-and-forget; never blocks boot.
            collapseMatchNotifications().catch((err) =>
                errorLogger.error(
                    'collapseMatchNotifications fallo:',
                    (err as Error)?.message
                )
            );
            // Idempotent migration: raise free users with the old limit (10) to 25.
            // Fire-and-forget.
            bumpFreeBondLimit().catch((err) =>
                errorLogger.error(
                    'bumpFreeBondLimit fallo:',
                    (err as Error)?.message
                )
            );
            // Idempotent migration: mark old ratings applied:true so reputations do
            // not regress. Fire-and-forget.
            applyExistingRatings().catch((err) =>
                errorLogger.error(
                    'applyExistingRatings fallo:',
                    (err as Error)?.message
                )
            );
            // Idempotent migration: seed `matchesNextAt` and normalize `isLinked` on
            // legacy links. Without it the sweep never sees pre-agenda links (`$lte`
            // does not match a missing field). Fire-and-forget.
            backfillAgendaMatcheo()
                .catch((err) =>
                    errorLogger.error(
                        'backfillAgendaMatcheo fallo:',
                        (err as Error)?.message
                    )
                )
                // After the agenda step, even if it failed: normalize missing
                // isPause/isLinked (changes who has live links) and seed
                // hasActiveBonds for everyone.
                .then(() => reconciliarVinculosVivos())
                .then((r) =>
                    logger.info(
                        `[vinculosVivos] backfill: ${r.duenos} con vínculos vivos · ${r.encendidos} encendidos · ${r.apagados} apagados`
                    )
                )
                .catch((err) =>
                    errorLogger.error(
                        'reconciliarVinculosVivos fallo:',
                        (err as Error)?.message
                    )
                );
        });
        initializeSocket(myServer).catch((err) =>
            errorLogger.error('Socket initialization failed:', err)
        );

        // Heavy matching runs in a dedicated process (dist/worker.js, PM2
        // "bankybondy-matcher"). The API only enqueues recomputes via Redis (BullMQ)
        // to keep the HTTP/socket event loop free, so no worker/sweep starts here.
    } catch (error) {
        logSeguro('Error in main function:', error);
        // Boot failed (e.g. Mongo down): abort for a clean restart. Delayed so the
        // failure log is not lost.
        salirDejandoRastro(1);
    }
}

// ───────────────────────────────────────────────────────────────────────────
// UNHANDLED REJECTIONS: LOG AND KEEP SERVING
//
// Old behavior was `myServer.close()` + forced exit, but server.close() never
// closes live websockets, so the callback never fired and the 10s timeout always
// won: 10s refusing every request plus a reconnect stampede. The trigger is
// reachable (@socket.io/redis-adapter publishes without await/catch, so a Redis
// blip during a chat message took the API down).
//
// Safe because an unhandled rejection is a promise nobody awaited; exiting only
// kills concurrent work. uncaughtException still exits (state may be corrupt).
// The worker (worker.ts) keeps exit(1): no websockets, BullMQ redelivers.
// ───────────────────────────────────────────────────────────────────────────

// CIRCUIT BREAKER: only a wedged process (e.g. exhausted Mongo pool) repeats the
// rejection forever, so a flood of rejections still exits.
const RECHAZOS_VENTANA_MS =
    Number(process.env.RECHAZOS_VENTANA_MS) || 60_000;
const RECHAZOS_LIMITE = Number(process.env.RECHAZOS_LIMITE) || 60;

// TRUE SLIDING WINDOW: keep timestamps, drop expired ones. A fixed window had two
// holes (boundary reset the counter: 19+19 in ~1s did not fire; a steady 19/min
// never fired, which is the wedged case). The 20/60s threshold was raised because
// a real sliding window is stricter and a bad minute should not cost a restart.
// Env-tunable.
const rechazosRecientes: number[] = [];

process.on('unhandledRejection', (error) => {
    // Stack printing comes from shared/logger.ts; logSeguro because logging must
    // not throw in here (see above).
    logSeguro('Unhandled Rejection (se sigue sirviendo):', error);

    const ahora = Date.now();
    rechazosRecientes.push(ahora);
    while (
        rechazosRecientes.length &&
        ahora - rechazosRecientes[0] > RECHAZOS_VENTANA_MS
    ) {
        rechazosRecientes.shift();
    }

    if (rechazosRecientes.length >= RECHAZOS_LIMITE) {
        // Deferred exit: winston writes async, a same-tick exit would swallow this.
        errorLogger.error(
            `Cortacircuitos: ${rechazosRecientes.length} rechazos en menos de ${
                RECHAZOS_VENTANA_MS / 1000
            }s. El proceso parece encajado; se sale para que PM2 lo reinicie limpio.`
        );
        setTimeout(() => process.exit(1), 100).unref();
    }
});

// Graceful shutdown: close the HTTP server and Mongo connection.
const gracefulShutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down gracefully`);
    if (myServer) {
        // CLOSE WEBSOCKETS FIRST: server.close() does not close live sockets, so the
        // callback below never fired while any socket was open; the 10s timeout won
        // and closeMatchingRobot()/mongoose close never ran on any deploy.
        try {
            getIO().close();
        } catch {
            // getIO() throws if the socket was never initialized (boot aborted
            // early); nothing to close, so continue shutting down.
        }
        myServer.close(async () => {
            try {
                // Drain presence BEFORE closing anything else: this instance removes
                // itself from shared Redis state, else every deploy leaves phantoms
                // online until the heartbeat sweep (~2 min). Safe here because no new
                // connection can arrive after close().
                await closePresence();
                await closeMatchingRobot();
                await mongoose.connection.close();
            } catch (err) {
                errorLogger.error('Error closing connections:', err);
            }
            logger.info('Server & DB connections closed');
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 10000).unref();
    } else {
        process.exit(0);
    }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

main();
