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
import {
    esInstanciaLider,
    etiquetaInstancia,
} from './app/utilities/instancia';

let myServer: HTTPServer | undefined;

// ───────────────────────────────────────────────────────────────────────────
// Dos helpers para que los caminos de MUERTE dejen rastro (10/9, 2ª ronda de panel).
//
// `logSeguro`: loguear NO puede tirar. `serializar` y el `printf` ya están
// blindados, pero queda una superficie fuera del alcance de logger.ts: winston
// hace `Object.assign({}, defaultMeta, meta, ...)` ANTES de correr cualquier
// format, así que un meta con un getter que lanza tira desde adentro de winston.
// Si eso pasara en el handler de `unhandledRejection`, se convertiría en
// `uncaughtException` y mataría el proceso — el arreglo anti-caída como causa de
// la caída.
//
// `salirDejandoRastro`: winston escribe a archivo de forma ASÍNCRONA, así que un
// `process.exit(1)` en el mismo tick se come justo el log que explica POR QUÉ se
// salió. Se midió: sin margen, la línea no llega al archivo. Se aplicaba sólo en
// el cortacircuitos y faltaba en los DOS caminos más importantes: el crash con
// estado corrupto y el arranque fallido.
// ───────────────────────────────────────────────────────────────────────────
const logSeguro = (mensaje: string, error?: unknown) => {
    try {
        errorLogger.error(mensaje, error);
    } catch {
        // Último recurso: la consola cruda, que no pasa por winston.
        // eslint-disable-next-line no-console
        console.error(mensaje, (error as Error)?.stack || error);
    }
};

const salirDejandoRastro = (codigo: number) => {
    setTimeout(() => process.exit(codigo), 100).unref();
};

// Excepciones no capturadas: estado corrupto -> salir para que el
// supervisor (PM2) reinicie el proceso limpio.
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

        // Aviso de config: el login con Google verifica el idToken contra
        // GOOGLE_CLIENT_ID (auth.services). Si falta, el login con Google (camino
        // PRINCIPAL de registro) falla en runtime. No se aborta el boot (el resto
        // del sistema anda), pero se deja un error VISIBLE en los logs de PM2.
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

            // ESCALA HORIZONTAL: las migraciones y el sembrado corren en UNA sola
            // instancia. Con `WEB_CONCURRENCY > 1`, PM2 levanta N copias de este
            // archivo y las cuatro de abajo saldrían en paralelo contra la misma
            // base — `collapseMatchNotifications` incluso colapsa duplicados y
            // crea un índice único. Son idempotentes, así que el daño esperado es
            // ruido y trabajo repetido, no corrupción; pero no hay ninguna razón
            // para pagarlo N veces. Ver utilities/instancia.ts.
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
            // Migración idempotente: colapsa las notificaciones MATCH duplicadas
            // que dejó el comportamiento anterior y crea el índice único por
            // vínculo. Fire-and-forget: nunca bloquea ni aborta el arranque.
            collapseMatchNotifications().catch((err) =>
                errorLogger.error(
                    'collapseMatchNotifications fallo:',
                    (err as Error)?.message
                )
            );
            // Migración idempotente: sube a 25 a los usuarios free con el límite
            // viejo (10). Fire-and-forget: nunca bloquea ni aborta el arranque.
            bumpFreeBondLimit().catch((err) =>
                errorLogger.error(
                    'bumpFreeBondLimit fallo:',
                    (err as Error)?.message
                )
            );
            // Migración idempotente: marca applied:true las calificaciones viejas
            // (pre rating-en-suspenso) para no regresar reputaciones. Fire-and-forget.
            applyExistingRatings().catch((err) =>
                errorLogger.error(
                    'applyExistingRatings fallo:',
                    (err as Error)?.message
                )
            );
            // Migración idempotente: siembra `matchesNextAt` y normaliza
            // `isLinked` en los vínculos legados. SIN ESTO el sweep no ve a los
            // vínculos anteriores a la agenda (un `$lte` no matchea un campo
            // ausente) y quedarían sin recomputarse para siempre. Fire-and-forget.
            backfillAgendaMatcheo()
                .catch((err) =>
                    errorLogger.error(
                        'backfillAgendaMatcheo fallo:',
                        (err as Error)?.message
                    )
                )
                // DESPUÉS del de la agenda, y aunque ese falle: normaliza
                // `isPause`/`isLinked` ausentes, y eso cambia quién tiene vínculos
                // vivos. Siembra `hasActiveBonds` (orden de Personas) en todos.
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

        // El matcheo pesado corre en un PROCESO DEDICADO (dist/worker.js, PM2
        // app "bankybondy-matcher"). La API sólo ENCOLA recomputos vía Redis
        // (BullMQ) para no bloquear el event loop de HTTP/sockets. Por eso aquí
        // ya NO se arrancan startMatchingWorker()/startMatchingSweep().
    } catch (error) {
        logSeguro('Error in main function:', error);
        // No se pudo arrancar (p.ej. Mongo caído): abortar para reinicio limpio.
        // Con margen, si no el log del arranque fallido se pierde justo cuando
        // es lo único que hay para diagnosticar.
        salirDejandoRastro(1);
    }
}

// ───────────────────────────────────────────────────────────────────────────
// RECHAZOS NO MANEJADOS: LOGUEAR Y SEGUIR (cambio de postura, 10/9)
//
// ANTES: `myServer.close(() => process.exit(1))` + salida forzada a los 10 s.
// Se midió lo que eso hacía DE VERDAD y era mucho peor que "reiniciar":
// `server.close()` NO cierra los websockets vivos, así que el callback NUNCA
// disparaba y siempre ganaba el timeout → **10 SEGUNDOS RECHAZANDO TODO**
// (ECONNREFUSED para cada request y cada handshake nuevo), después la salida,
// después la reconexión en manada de todos los clientes, cada uno con
// `jwt.verify` + `User.findById`. Con `instances: 1` no hay redundancia: era
// caída total de 15-25 s por CADA promesa rechazada suelta.
//
// Y el gatillo alcanzable HOY no es exótico: `@socket.io/redis-adapter` hace
// `pubClient.publish()` sin await ni catch en 11 sitios, y node-redis rechaza
// TODA promesa en vuelo ante cualquier error del socket. O sea: un parpadeo de
// Redis durante un mensaje de chat tumbaba la API para todos. Peor todavía, con
// una sola instancia ese publish no le sirve a nadie —la entrega local corre
// igual— así que el sistema se suicidaba por un mensaje que nadie necesitaba.
//
// POR QUÉ SEGUIR ES SEGURO: un `unhandledRejection` es, por definición, una
// promesa que NADIE estaba esperando. La función async que la produjo ya se
// detuvo y no va a continuar, se salga o no. Salir no deshace su trabajo
// parcial: sólo AGREGA el daño de matar todo lo concurrente. Se revisaron los
// caminos de estado (transacciones de mongoose, escrituras multi-paso, plata,
// jobs de BullMQ) y no se encontró ninguno donde seguir sea peor que reiniciar.
//
// `uncaughtException` (arriba) SIGUE MATANDO el proceso, a propósito: ahí el
// estado sí puede estar corrupto. Y hoy no lo dispara nada — se barrió el árbol
// buscando esa clase y no quedó ninguna instancia.
//
// El WORKER (`worker.ts`) conserva el `exit(1)`: no tiene websockets, reinicia
// gratis y BullMQ re-entrega los jobs.
// ───────────────────────────────────────────────────────────────────────────

// CORTACIRCUITOS: el único escenario donde "seguir" es peor que salir es un
// proceso ENCAJADO (p. ej. pool de Mongo agotado) donde el rechazo se repite
// para siempre y la degradación silenciosa reemplaza al reinicio ruidoso. Si
// llueven rechazos, se sale igual.
const RECHAZOS_VENTANA_MS =
    Number(process.env.RECHAZOS_VENTANA_MS) || 60_000;
const RECHAZOS_LIMITE = Number(process.env.RECHAZOS_LIMITE) || 60;

// VENTANA MÓVIL DE VERDAD: se guardan los timestamps y se descartan los que
// salieron de la ventana. La versión anterior usaba una ventana FIJA
// (`ventanaDesde` + reset) y tenía dos agujeros, los dos probados por el panel:
//   - 19 rechazos en t=59s y 19 más en t=60.001s = 38 en un segundo, y NO
//     disparaba, porque el borde reseteaba el contador a cero.
//   - un goteo sostenido de 19 por minuto no disparaba NUNCA — que es
//     exactamente el "proceso encajado" que este cortacircuitos dice cubrir.
// CORRECCIÓN (2ª ronda de panel): una versión anterior de este comentario decía
// que "el array está acotado por construcción: nunca supera RECHAZOS_LIMITE".
// Es FALSO y está medido: llega a 38 en el escenario del borde que se describe
// acá arriba, y a miles en una tormenta, porque el `exit` va diferido y se sigue
// apilando mientras tanto. En memoria es trivial (son números), pero la
// afirmación era falsa.
//
// AJUSTE DE SENSIBILIDAD, decidido a conciencia: los números 20/60s venían de
// cuando la ventana FIJA los volvía mucho más laxos en la práctica. Con ventana
// móvil de verdad, 20 en 60 s es un ritmo alcanzable en un hipo de Mongo o de S3
// en un minuto cargado, SIN que el proceso esté encajado — y disparar cuesta
// exactamente lo que esta tanda quiere evitar (reinicio + todos los websockets
// cortados + reconexión en manada). Se sube el umbral para que siga cubriendo el
// "proceso encajado" sin castigar un mal minuto. Ajustable por env.
const rechazosRecientes: number[] = [];

process.on('unhandledRejection', (error) => {
    // El stack se imprime gracias a los arreglos de shared/logger.ts. Sin eso,
    // esto sería un log ciego, que es peor que el crash que reemplaza.
    // `logSeguro` porque loguear no puede tirar acá adentro (ver arriba).
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
        // `exit` DIFERIDO: winston escribe a archivo de forma asíncrona, así que
        // un `process.exit(1)` en el mismo tick se come justo el log que explica
        // POR QUÉ se salió. Un tick de margen alcanza para que se vacíe.
        errorLogger.error(
            `Cortacircuitos: ${rechazosRecientes.length} rechazos en menos de ${
                RECHAZOS_VENTANA_MS / 1000
            }s. El proceso parece encajado; se sale para que PM2 lo reinicie limpio.`
        );
        setTimeout(() => process.exit(1), 100).unref();
    }
});

// Apagado graceful: cerrar servidor HTTP y conexion de Mongo.
const gracefulShutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down gracefully`);
    if (myServer) {
        // CERRAR LOS WEBSOCKETS PRIMERO (arreglado 10/9, panel adversarial).
        //
        // `server.close()` deja de aceptar conexiones nuevas pero NO cierra las
        // vivas, y un websocket no se cierra solo. Como nadie llamaba `io.close()`
        // en todo el árbol, el callback de abajo NUNCA disparaba mientras hubiera
        // un socket abierto: ganaba siempre el `setTimeout` de 10 s, se salía con
        // código 1, y `closeMatchingRobot()` y `mongoose.connection.close()` NO
        // CORRÍAN NUNCA.
        //
        // Es el MISMO defecto que motivó el cambio de postura de arriba, y había
        // quedado vivo en el camino que de verdad se ejecuta siempre: este corre
        // en CADA `pm2 restart`, o sea en cada deploy. El otro sólo corría ante
        // un rechazo suelto.
        try {
            getIO().close();
        } catch {
            // `getIO()` tira si el socket nunca se inicializó (arranque abortado
            // temprano). No hay nada que cerrar; se sigue con el apagado.
        }
        myServer.close(async () => {
            try {
                // La presencia se drena ANTES de cerrar nada más: esta instancia
                // se borra a sí misma del estado compartido de Redis. Sin esto,
                // CADA deploy dejaría fantasma a todos sus conectados hasta que el
                // barrido por latido los levante (hasta ~2 min de gente que figura
                // online sin estarlo, justo cuando más reinicios hay).
                //
                // Va acá y no antes porque `myServer.close()` ya dejó de aceptar
                // conexiones e `io.close()` cerró los websockets: no puede entrar
                // nadie nuevo después de drenar.
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
