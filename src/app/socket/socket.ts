/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createAdapter } from '@socket.io/redis-adapter';
import { Server as HTTPServer } from 'http';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { createClient } from 'redis';
import { Server as IOServer, Socket } from 'socket.io';
import config from '../config';
import { User } from '../modules/user/user.model';
import { esObjectIdUsable } from '../utilities/objectId';
import handleChat from './handleChat';
import {
    contarOnline,
    entraInstancia,
    initPresence,
    muestraOnline,
    saleInstancia,
} from './presence';

let io: IOServer;

/** ¿Corremos con más de una instancia de la API?
 *
 *  `ecosystem.config.js` inyecta `WEB_CONCURRENCY` al proceso hijo justamente
 *  para que el código pueda saberlo. Cambia una sola decisión, pero importante:
 *  sin adapter de Redis, con una instancia se sigue sirviendo perfecto y con
 *  varias los mensajes dejan de cruzar entre procesos. */
const MULTI_INSTANCIA = Number(process.env.WEB_CONCURRENCY || 1) > 1;

// ESCALA: DOS diales, separados a propósito.
//
// Una versión anterior usaba uno solo para las dos cosas, y el propio comentario
// que lo documentaba describía sólo la mitad de su efecto: decía que
// `PRESENCE_BROADCAST_MAX=0` "apaga los deltas", y de paso achicaba la foto del
// handshake a UN usuario al azar; y que "un número muy grande los deja como
// estaban", lo que además reintroducía el `SMEMBERS` O(N) que esta tanda vino a
// sacar. Un interruptor de emergencia que rompe un dato distinto del que dice
// tocar es peor que no tenerlo. (Panel del 11/9.)
//
// `||` y no `??` en los dos: es la convención del repo (17 de 19 usos) y evita
// que un `PRESENCE_BROADCAST_MAX=` vacío —la forma más común de dejar una
// variable anotada en un `.env`— dé `Number('') === 0` y apague cosas en silencio.

/** Tope de la FOTO inicial que recibe cada socket al conectarse. Acota el tamaño
 *  de la respuesta del handshake; nunca la apaga. */
const TOPE_FOTO = Math.max(Number(process.env.PRESENCE_SNAPSHOT_MAX) || 1000, 1);

/** Por encima de esta cantidad de conectados se dejan de difundir los deltas
 *  globales `user-online` / `user-offline`.
 *
 *  El fan-out de un delta es O(conectados) y los deltas crecen con los
 *  conectados: a 50.000 es el evento más caro del sistema, y no lo escucha nadie
 *  en web ni en dashboard (grepeado; ver el comentario largo abajo). El default
 *  (1.000) está elegido para que HOY no cambie absolutamente nada —hay 47
 *  usuarios— y para que el costo quede acotado cuando no los haya.
 *
 *  `PRESENCE_BROADCAST_MAX=0` los apaga siempre, y ahora eso NO toca la foto. */
const TOPE_DELTAS = (() => {
    const crudo = process.env.PRESENCE_BROADCAST_MAX;
    if (crudo !== undefined && crudo.trim() === '0') return 0; // apagado explícito
    return Math.max(Number(crudo) || 1000, 0);
})();

/** ¿Conviene todavía difundir deltas de presencia a TODOS los sockets?
 *
 *  Es `SCARD` —O(1) en Redis—, no un recuento de sockets. Se consulta por evento
 *  a propósito: el umbral tiene que poder cruzarse en caliente, sin reiniciar. */
const deltasHabilitados = async (): Promise<boolean> => {
    if (TOPE_DELTAS <= 0) return false;
    try {
        return (await contarOnline()) <= TOPE_DELTAS;
    } catch {
        // Ante la duda, NO difundir: el modo de falla de difundir de más es
        // justamente el techo que esto viene a sacar.
        return false;
    }
};

const initializeSocket = async (server: HTTPServer) => {
    if (!io) {
        io = new IOServer(server, {
            pingTimeout: 60000,
            cors: {
                origin: [
                    'https://bankybondy.com',
                    'https://www.bankybondy.com',
                    'https://admin.bankybondy.com',
                    'http://localhost:3000',
                    'http://localhost:3001',
                    'http://localhost:3002',
                ],
            },
        });

        /* ═══════════════════════════════════════════════════════════════════
         * LA PUERTA DE ARRANQUE — el arreglo del defecto más grave del módulo.
         *
         * QUÉ PASABA (verificado midiendo, no leyendo): `connect()` de node-redis
         * **no rechaza nunca** contra un Redis caído — reintenta para siempre y la
         * promesa no se resuelve ni se rechaza. Medido: a los 8 s, `isOpen: true`,
         * `isReady: false`, 8 errores emitidos, promesa colgada.
         *
         * Y el `await Promise.all([pubClient.connect(), subClient.connect()])`
         * estaba ANTES de `io.on('connection', ...)`. O sea que si Redis estaba
         * caído o lento al arrancar la API —justo cuando más reinicios hay— el
         * handler de conexiones NO SE REGISTRABA NUNCA. Los sockets se conectaban,
         * quedaban sin autenticar, sin room, sin chat y sin presencia. Para
         * siempre. Sin una línea de log. Y la API seguía sirviendo HTTP normal,
         * así que desde afuera no se notaba.
         *
         * CÓMO SE ARREGLA, y por qué no alcanzaba con mover el handler arriba:
         * `io.adapter()` reemplaza el registro de rooms, así que un socket que se
         * conecte ANTES de que el adapter se instale deja sus rooms en el adapter
         * viejo y queda mudo. Mover el handler solo cambiaba un modo de falla por
         * otro.
         *
         * La solución es esta puerta: **el handler se registra ya**, así que no
         * hay ventana sin handler, pero cada conexión ESPERA a que la cuestión del
         * adapter esté resuelta antes de tocar rooms. En el caso normal son
         * milisegundos; en el peor caso, el timeout.
         * ═══════════════════════════════════════════════════════════════════ */
        let abrirPuerta: () => void = () => undefined;
        const listoParaAtender = new Promise<void>((resolver) => {
            abrirPuerta = resolver;
        });

        // Techo duro a la espera. Sin esto la puerta podría no abrirse nunca, que
        // es exactamente el defecto que se está cerrando.
        const TIMEOUT_ADAPTER_MS =
            Number(process.env.SOCKET_ADAPTER_TIMEOUT_MS) || 10_000;

        // Escala horizontal: adapter de Redis (opcional via REDIS_URL).
        // Con varias instancias, permite que los eventos lleguen a los
        // sockets conectados a OTRA instancia. Sin Redis, corre single-instance.
        const montarAdapter = async (): Promise<void> => {
            if (!config.redis_url) {
                // SIN REDIS Y CON MULTI-INSTANCIA no hay forma de que un mensaje
                // llegue a alguien conectado a otro proceso. Es el olvido
                // operativo más común que existe (falta una variable de entorno) y
                // hasta acá pasaba en completo silencio.
                if (MULTI_INSTANCIA) {
                    console.error(
                        'FATAL: WEB_CONCURRENCY > 1 sin REDIS_URL. Los mensajes no cruzarían ' +
                            'entre instancias y la presencia se corrompería. Se sale para reinicio limpio.'
                    );
                    setTimeout(() => process.exit(1), 100).unref();
                }
                return;
            }
            try {
                const pubClient = createClient({ url: config.redis_url });
                const subClient = pubClient.duplicate();
                pubClient.on('error', (err) =>
                    console.error('Redis pub error:', err)
                );
                subClient.on('error', (err) =>
                    console.error('Redis sub error:', err)
                );
                // TIMEOUT OBLIGATORIO: `connect()` no rechaza contra un Redis
                // caído (medido), así que sin la carrera este `await` es el que
                // colgaba el arranque entero del socket.
                await Promise.race([
                    Promise.all([pubClient.connect(), subClient.connect()]),
                    new Promise((_, rechazar) =>
                        setTimeout(
                            () =>
                                rechazar(
                                    new Error(
                                        `Redis no respondió en ${TIMEOUT_ADAPTER_MS} ms`
                                    )
                                ),
                            TIMEOUT_ADAPTER_MS
                        ).unref()
                    ),
                ]);

                // EL GATILLO GRAVE, TAPADO EN LA FUENTE (10/9).
                //
                // `@socket.io/redis-adapter` llama `pubClient.publish(...)` en 11
                // sitios SIN `await` y SIN `.catch()`, e IGNORA el valor de retorno.
                // node-redis, ante CUALQUIER error del socket, hace `flushAll(err)`
                // y RECHAZA toda promesa de comando en vuelo. O sea: un parpadeo de
                // Redis mientras se emite un mensaje de chat producía un rechazo
                // suelto que llegaba a `server.ts` y tumbaba la API PARA TODOS.
                // (Medido punta a punta contra un Redis que corta el socket con un
                // publish en vuelo.) El `pubClient.on('error')` de arriba NO salva
                // esa promesa: cubre el evento del cliente, no el comando.
                //
                // Y el remate: en el adapter, la entrega LOCAL (`super.broadcast`)
                // corre igual, siempre, después del publish. Con `instances: 1` ese
                // publish no le sirve a NADIE — no hay otra instancia escuchando.
                // El sistema se caía por un mensaje que no le hacía falta a nadie.
                //
                // Se envuelve `publish` para que nunca rechace suelto. Es seguro
                // porque los 11 sitios ignoran el retorno. `server.ts` ya no muere
                // por esto, pero se tapa igual en la fuente: la red del proceso es
                // el último recurso, no el primero.
                // Se envuelven los comandos que el adapter dispara SIN await y
                // SIN catch: `publish` del pubClient (el de cada mensaje) y
                // `pSubscribe`/`subscribe` (constructor del adapter) y
                // `pUnsubscribe`/`unsubscribe` (su `close`) del subClient.
                //
                // PRECISIÓN (2ª ronda de panel): una versión anterior decía que
                // el subClient tenía "EXACTAMENTE el mismo patrón". El PATRÓN sí
                // —promesa flotante— pero NO el modo de falla. Se midió: sobre un
                // cliente desconectado, `publish` RECHAZA ("The client is
                // closed"), mientras que los cuatro del subClient **nunca
                // resuelven**. Contra un cuelgue, un `.catch()` no hace nada.
                // Envolverlos igual sirve —sí rechazan cuando el socket se cae
                // con comandos en vuelo— pero la paridad no es total.
                const blindar = (
                    cliente: any,
                    metodo: string,
                    etiqueta: string
                ) => {
                    if (typeof cliente[metodo] !== 'function') return;
                    const original = cliente[metodo].bind(cliente);
                    cliente[metodo] = (...args: unknown[]) => {
                        try {
                            const r = original(...args);
                            // Sólo encadenamos si de verdad es una promesa: si
                            // alguna versión devolviera otra cosa, no la rompemos.
                            return r && typeof r.catch === 'function'
                                ? r.catch((err: unknown) => {
                                      console.error(
                                          `Redis ${etiqueta} falló (se sigue sirviendo):`,
                                          (err as Error)?.message
                                      );
                                  })
                                : r;
                        } catch (err) {
                            console.error(
                                `Redis ${etiqueta} tiró sincrónico (se sigue sirviendo):`,
                                (err as Error)?.message
                            );
                        }
                    };
                };
                blindar(pubClient, 'publish', 'publish');
                for (const m of [
                    'subscribe',
                    'pSubscribe',
                    'unsubscribe',
                    'pUnsubscribe',
                ]) {
                    blindar(subClient, m, m);
                }

                io.adapter(createAdapter(pubClient, subClient));
                console.log('Socket.io Redis adapter enabled');
            } catch (err) {
                // ⚠️ ACÁ SE DECIDE DISTINTO SEGÚN LA TOPOLOGÍA (panel del 11/9).
                //
                // Antes esto sólo logueaba "running single-instance" y seguía. Con
                // UNA instancia eso es correcto: el adapter no le sirve a nadie —lo
                // dice el comentario largo de arriba— y la entrega local funciona
                // igual.
                //
                // Con VARIAS es otra cosa: sin adapter los eventos no cruzan entre
                // procesos, así que un mensaje de chat no le llega al destinatario
                // si está conectado a otra instancia. En silencio y para toda la
                // vida del proceso, porque nada reintenta.
                //
                // Y REINTENTAR TAMPOCO SIRVE, que era lo primero que pensé:
                // `io.adapter()` reemplaza el registro de rooms, y los sockets que
                // se hayan conectado mientras tanto tienen sus rooms en el adapter
                // VIEJO. Cambiarlo en caliente los deja mudos. O sea que instalar
                // el adapter tarde es peor que no instalarlo.
                //
                // Entonces: con multi-instancia este proceso NO está en condiciones
                // de servir, y lo mejor que puede hacer es decirlo fuerte y morirse
                // para que PM2 lo levante limpio. Un bucle de reinicio se ve; la
                // corrupción silenciosa no.
                console.error(
                    'Redis adapter setup failed:',
                    (err as Error)?.message
                );
                if (MULTI_INSTANCIA) {
                    console.error(
                        'FATAL: con WEB_CONCURRENCY > 1 el adapter de Redis es obligatorio ' +
                            '(sin él los mensajes no cruzan entre instancias). Se sale para reinicio limpio.'
                    );
                    setTimeout(() => process.exit(1), 100).unref();
                    return;
                }
                console.error('Se sigue sirviendo single-instance.');
            }
        };

        // Se dispara SIN await: el registro del handler de abajo no puede quedar
        // detrás de una promesa que puede no resolverse. La puerta se abre pase lo
        // que pase — con adapter, sin adapter o por timeout.
        void montarAdapter().finally(() => abrirPuerta());

        // LA PRESENCIA VA APARTE DEL ADAPTER, y no es un detalle de orden.
        //
        // Antes `initPresence()` se llamaba ADENTRO del `try` de arriba, después
        // de los `connect()`. Si Redis tenía un hipo justo en el arranque —que es
        // cuando más reinicios hay— la presencia quedaba en el Set en memoria de
        // cada proceso PARA SIEMPRE, que con multi-instancia es exactamente la
        // corrupción que `presence.ts` existe para hacer imposible. Y nada lo
        // decía: `/ready` reportaba `caido` eternamente aunque Redis ya hubiera
        // vuelto. Ahora tiene su propio ciclo de vida y su propio reintento.
        //
        // Sin `await`: que el server acepte conexiones no puede depender de esto.
        void initPresence();

        io.on('connection', async (socket: Socket) => {
            try {
                // Esperar a que la cuestión del adapter esté resuelta ANTES de
                // tocar rooms (el `socket.join` de más abajo). En el caso normal
                // ya está resuelta y esto no cuesta nada; en el malo, acota. Lo
                // importante es que el handler EXISTE desde el arranque: un socket
                // que entre acá va a ser atendido, aunque tenga que esperar.
                await listoParaAtender;

                const token =
                    socket.handshake.auth?.token ||
                    socket.handshake.query?.token;
                if (!token) {
                    socket.disconnect(true);
                    return;
                }
                const decode = jwt.verify(
                    token as string,
                    config.jwt_access_secret as string
                ) as JwtPayload;

                // Seguridad: antes el socket solo verificaba la FIRMA del token.
                // Ahora replica los chequeos del middleware HTTP (auth.ts): si el
                // usuario fue borrado/bloqueado, no está verificado, o cambió la
                // contraseña después de emitir el token → se rechaza la conexión.
                // Sin esto, un usuario baneado seguía chateando y figurando online
                // hasta que venciera el token.
                //
                // El `id` se valida ANTES de usarlo, por lo mismo que en auth.ts:
                // `User.findById(undefined)` da filtro `{}` y devuelve el PRIMER
                // usuario de la colección (el superAdmin sembrado). Este archivo NO
                // pasa por auth.ts, así que la guarda hay que repetirla acá.
                if (!esObjectIdUsable(decode.id)) {
                    socket.disconnect(true);
                    return;
                }

                const dbUser = await User.findById(decode.id);
                const pwdChanged =
                    dbUser?.passwordChangedAt && decode.iat
                        ? new Date(dbUser.passwordChangedAt).getTime() / 1000 >
                          (decode.iat as number)
                        : false;
                if (
                    !dbUser ||
                    dbUser.isDeleted ||
                    dbUser.isBlocked ||
                    !dbUser.isVerified ||
                    pwdChanged
                ) {
                    socket.disconnect(true);
                    return;
                }

                // El profileId sale del documento FRESCO, igual que en auth.ts, y
                // NO del token. Es importante que las dos puertas usen el mismo
                // criterio: si acá se validara `decode.profileId`, un access token
                // viejo (hasta 30 días) sin esa claim tendría la web funcionando
                // —porque el middleware HTTP lo hidrata— y el socket muerto, en
                // silencio. Se valida igual: sin un profileId usable, todos los
                // usuarios rotos compartirían el MISMO room y la misma entrada de
                // presencia (`socket.join` + `entraInstancia`, abajo).
                const currentUserId = String(dbUser.profileId ?? '');
                if (!esObjectIdUsable(currentUserId)) {
                    socket.disconnect(true);
                    return;
                }
                socket.join(currentUserId);

                // ── PRESENCIA (ver app/socket/presence.ts para el diseño) ──
                //
                // Dos capas, y la distinción es la que hace que el multi-instancia
                // funcione:
                //
                //   LOCAL  — `adapter.rooms` es autoridad DENTRO de esta instancia.
                //            Nos dice si este socket es el primero/último que ESTA
                //            instancia tiene de este usuario.
                //   GLOBAL — el contador en Redis nos dice si además somos la
                //            primera/última INSTANCIA que lo tiene.
                //
                // Antes acá se usaba la capa local para escribir la global, y eso
                // era lo que rompía con `WEB_CONCURRENCY > 1`: cerrar una pestaña
                // en la instancia A marcaba offline a alguien conectado en B.
                //
                // `esPrimeraLocal`: abrir tres pestañas NO debe tocar Redis tres
                // veces. Se mira el tamaño del room DESPUÉS del join (1 = este
                // socket es el único). Es seguro: entre el `join` y esta lectura no
                // hay ningún `await`, y el adapter de Redis hereda `addAll` sin
                // sobreescribirlo, así que el join es síncrono.
                const roomAlEntrar = io.sockets.adapter.rooms.get(currentUserId);
                const esPrimeraLocal = !roomAlEntrar || roomAlEntrar.size === 1;

                let esPrimeraGlobal = false;
                if (esPrimeraLocal) {
                    ({ primeraGlobal: esPrimeraGlobal } =
                        await entraInstancia(currentUserId));
                }

                // FUGA DE FANTASMAS — el `disconnect` se registra ACÁ, no al final.
                //
                // Antes se registraba DESPUÉS de la foto de presencia y de
                // `await handleChat(...)`. Si el transporte se caía durante ese ida
                // y vuelta a Redis, socket.io emitía 'disconnect' SIN NINGÚN
                // listener: el evento se perdía, la baja no corría nunca y ese id
                // quedaba marcado online PARA SIEMPRE en el estado compartido.
                // Nada fallaba y nada se logueaba.
                //
                // OJO, y por esto NO va más arriba: registrarlo ANTES de
                // `entraInstancia` abre la carrera por el otro lado. El caso
                // peligroso es que el socket se caiga ANTES de que el alta llegue a
                // Redis: ahí el handler corre primero, no saca nada porque el id
                // todavía no entró, y el alta lo agrega después → fantasma igual.
                // El punto seguro es inmediatamente después de que el alta resolvió,
                // que es acá.
                //
                // Y AHORA, ADEMÁS, HAY RED: si un proceso se muere sin pasar por
                // ningún handler, el barrido por latido de `presence.ts` drena su
                // rastro. Esta ventana sigue cerrándose acá porque es el camino
                // limpio y cuesta nada; la red es para lo que no tiene camino limpio.
                let yaLimpiado = false;
                const marcarOfflineSiCorresponde = async () => {
                    if (yaLimpiado) return;
                    yaLimpiado = true;
                    // Presencia por-CONEXIÓN, no por-usuario: cerrar una de dos
                    // pestañas no debe marcar offline a quien sigue conectado en la
                    // otra. Al momento del 'disconnect' este socket YA salió del
                    // room, así que `size > 0` significa "quedan otros".
                    const room = io.sockets.adapter.rooms.get(currentUserId);
                    const quedanLocales = room ? room.size > 0 : false;
                    if (quedanLocales) return;

                    // Esta instancia se quedó sin sockets del usuario. Sólo pasa a
                    // offline DE VERDAD si tampoco lo tiene ninguna otra.
                    const { ultimaGlobal } = await saleInstancia(currentUserId);
                    if (ultimaGlobal && await deltasHabilitados()) {
                        io.emit('user-offline', currentUserId);
                    }
                };
                socket.on('disconnect', marcarOfflineSiCorresponde);

                // Y si se cayó DURANTE el alta —cuando todavía no había listener—,
                // socket.io ya emitió su 'disconnect' y no lo va a repetir: hay que
                // limpiar a mano. El guard `yaLimpiado` hace que esto sea
                // idempotente si además llegara el evento.
                if (socket.disconnected) {
                    await marcarOfflineSiCorresponde();
                    return;
                }

                // ── LOS DOS COSTOS O(N) QUE ACÁ SE ACOTAN ───────────────────
                //
                // 1) La FOTO por handshake. Era `SMEMBERS` del Set entero: un
                //    comando O(N) sobre un Redis de UN SOLO HILO —el mismo que
                //    atiende BullMQ, los rate limits y el adapter de sockets— y un
                //    payload O(N), en CADA conexión. Ahora es `SRANDMEMBER key
                //    <tope>`, acotado por construcción. Con la escala de hoy (47
                //    usuarios) el tope no muerde y la foto es idéntica a la de
                //    siempre; con 50.000 conectados es una muestra en vez de una
                //    bomba.
                //
                // 2) Los DELTAS globales. `user-online` / `user-offline` van a
                //    TODOS los sockets en cada conexión y desconexión: fan-out O(N)
                //    por evento, y los eventos crecen con N.
                //
                // POR QUÉ SE PUEDE ACOTAR SIN ROMPER NADA: se grepeó `web/src` y
                // `dashboard/src` enteros y **no hay un solo listener** de
                // `onlineUser`, `user-online` ni `user-offline`. El filtro "online"
                // de Personas no los usa: lee el estado por HTTP
                // (`normalUser.services.ts`).
                //
                // La app nativa NO está en el repo, así que esto es INFERENCIA y
                // queda declarada: si escucha `onlineUser`, sigue recibiendo su foto
                // (muestreada por encima del tope) y perdería sólo el refresco en
                // vivo cuando haya más conectados que el tope. Presencia congelada,
                // cosmético. Reversible con `PRESENCE_BROADCAST_MAX`.
                socket.emit('onlineUser', await muestraOnline(TOPE_FOTO));
                if (esPrimeraGlobal && (await deltasHabilitados())) {
                    socket.broadcast.emit('user-online', currentUserId);
                }

                await handleChat(io, socket, currentUserId);
            } catch (error) {
                console.error('Socket authentication failed:', error);
                socket.disconnect(true);
            }
        });
    }
    return io;
};

const getIO = () => {
    if (!io) {
        throw new Error(
            'Socket.io is not initialized. Call initializeSocket first.'
        );
    }
    return io;
};

export { getIO, initializeSocket };
