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

/** True when more than one API instance runs (`ecosystem.config.js` injects
 *  `WEB_CONCURRENCY`). Without the Redis adapter, single-instance serves fine but
 *  events stop crossing processes. */
const MULTI_INSTANCIA = Number(process.env.WEB_CONCURRENCY || 1) > 1;

// SCALE: two separate dials on purpose. A single switch silently shrank the
// handshake snapshot to one user and re-enabled the O(N) `SMEMBERS`. `||` (repo
// convention) keeps an empty `PRESENCE_BROADCAST_MAX=` from reading as 0.

/** Cap on the initial snapshot each socket receives: bounds the handshake
 *  response size, never disables it. */
const TOPE_FOTO = Math.max(Number(process.env.PRESENCE_SNAPSHOT_MAX) || 1000, 1);

/** Beyond this many connected users, global `user-online` / `user-offline` deltas
 *  stop broadcasting (fan-out is O(connected) and nothing in web/dashboard listens).
 *  `PRESENCE_BROADCAST_MAX=0` disables them always without touching the snapshot. */
const TOPE_DELTAS = (() => {
    const crudo = process.env.PRESENCE_BROADCAST_MAX;
    if (crudo !== undefined && crudo.trim() === '0') return 0; // explicit off
    return Math.max(Number(crudo) || 1000, 0);
})();

/** Whether global presence deltas are still worth broadcasting. Uses `SCARD`
 *  (O(1)) so the threshold can be crossed without a restart. */
const deltasHabilitados = async (): Promise<boolean> => {
    if (TOPE_DELTAS <= 0) return false;
    try {
        return (await contarOnline()) <= TOPE_DELTAS;
    } catch {
        // When in doubt, don't broadcast: over-broadcasting is what this caps.
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

        /* STARTUP GATE. node-redis `connect()` never rejects against a dead Redis, so
         * awaiting it before registering the connection handler left sockets
         * permanently unauthenticated when Redis was slow at boot. The handler is
         * registered right away, but each connection waits here until `io.adapter()`
         * is settled — joining rooms before that strands them in the old adapter. */
        let abrirPuerta: () => void = () => undefined;
        const listoParaAtender = new Promise<void>((resolver) => {
            abrirPuerta = resolver;
        });

        // Hard ceiling on the wait: without it the gate could stay shut forever.
        const TIMEOUT_ADAPTER_MS =
            Number(process.env.SOCKET_ADAPTER_TIMEOUT_MS) || 10_000;

        // Optional Redis adapter so events reach sockets on other instances.
        const montarAdapter = async (): Promise<void> => {
            if (!config.redis_url) {
                // Multi-instance without Redis cannot cross messages: fail loud, not silent.
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
                // Mandatory timeout: `connect()` never rejects, so this race is what
                // kept a dead Redis from hanging the whole socket startup.
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

                // The adapter fires `publish` and the subClient's
                // `subscribe`/`pSubscribe`/`unsubscribe`/`pUnsubscribe` without await or
                // catch, and node-redis rejects every in-flight command on a socket
                // error: a Redis blip during a chat emit used to crash the API via a
                // floating rejection. Safe to wrap because all call sites ignore the
                // return. `publish` rejects when closed; the subClient commands hang
                // instead, so their catch is inert but harmless.
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
                            // Chain only real promises so odd return types stay intact.
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
                // Topology decides: one instance keeps serving without an adapter (local
                // delivery works); with several, events can't cross, and retrying later
                // is worse than not installing it — `io.adapter()` swaps the room
                // registry and strands sockets already in rooms. So exit for a clean restart.
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

        // Not awaited: the handler registration must not sit behind a promise that may
        // never settle. The gate opens either way — adapter, no adapter, or timeout.
        void montarAdapter().finally(() => abrirPuerta());

        // Presence has its own lifecycle and retry, outside the adapter try: a Redis
        // blip at startup used to pin it to the per-process memory Set for good (the
        // multi-instance corruption presence.ts prevents), with `/ready` reporting
        // `caido` forever. Not awaited so connection setup doesn't depend on it.
        void initPresence();

        io.on('connection', async (socket: Socket) => {
            try {
                // Wait until the adapter question is settled before touching rooms
                // (`socket.join` below). The handler already exists, so this socket is
                // served either way; the wait is bounded by the timeout.
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

                // Security: mirrors the HTTP middleware (auth.ts) — deleted, blocked,
                // unverified or password-changed users are rejected. `id` is validated
                // first because `User.findById(undefined)` filters `{}` and returns the
                // first user; this path never goes through auth.ts.
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

                // `profileId` comes from the fresh document, not the token, same as
                // auth.ts: a stale token without the claim would leave the socket dead
                // while HTTP works, and an unusable id would put every broken user in
                // the same room and presence entry (`socket.join` + `entraInstancia`).
                const currentUserId = String(dbUser.profileId ?? '');
                if (!esObjectIdUsable(currentUserId)) {
                    socket.disconnect(true);
                    return;
                }
                socket.join(currentUserId);

                // ── PRESENCE (design in app/socket/presence.ts) ──
                //
                // LOCAL: `adapter.rooms` is authority within this instance (first/last
                // socket here). GLOBAL: the Redis counter says whether we are also the
                // first/last instance. Using the local layer to write the global one is
                // what broke under `WEB_CONCURRENCY > 1` (a tab closed in A marked B offline).
                //
                // `esPrimeraLocal` reads room size after join (1 = only socket) so three
                // tabs don't hit Redis three times; no `await` in between, and the Redis
                // adapter inherits `addAll`, so the join is synchronous.
                const roomAlEntrar = io.sockets.adapter.rooms.get(currentUserId);
                const esPrimeraLocal = !roomAlEntrar || roomAlEntrar.size === 1;

                let esPrimeraGlobal = false;
                if (esPrimeraLocal) {
                    ({ primeraGlobal: esPrimeraGlobal } =
                        await entraInstancia(currentUserId));
                }

                // GHOST LEAK: the `disconnect` listener registers here, right after the
                // join resolved. Earlier (after the snapshot and `handleChat`) a dropped
                // transport lost the event and that id stayed online forever; registering
                // before `entraInstancia` races the other way, since the leave would run
                // before the join reaches Redis. The heartbeat sweep in presence.ts
                // covers processes that die without a clean path.
                let yaLimpiado = false;
                const marcarOfflineSiCorresponde = async () => {
                    if (yaLimpiado) return;
                    yaLimpiado = true;
                    // Presence is per-connection: closing one of two tabs must not mark
                    // the other offline. On 'disconnect' this socket already left the
                    // room, so `size > 0` means others remain.
                    const room = io.sockets.adapter.rooms.get(currentUserId);
                    const quedanLocales = room ? room.size > 0 : false;
                    if (quedanLocales) return;

                    // This instance has no sockets left for the user; only go offline if
                    // no other instance holds one.
                    const { ultimaGlobal } = await saleInstancia(currentUserId);
                    if (ultimaGlobal && await deltasHabilitados()) {
                        io.emit('user-offline', currentUserId);
                    }
                };
                socket.on('disconnect', marcarOfflineSiCorresponde);

                // If the socket dropped during the join there was no listener yet and
                // socket.io won't re-emit, so clean up manually; `yaLimpiado` keeps this
                // idempotent if the event also arrives.
                if (socket.disconnected) {
                    await marcarOfflineSiCorresponde();
                    return;
                }

                // ── THE TWO O(N) COSTS CAPPED HERE ───────────────────────────
                //
                // 1) Handshake snapshot was a full `SMEMBERS` on the shared
                //    single-threaded Redis (also serving BullMQ, rate limits and the
                //    adapter) on every connection; now `SRANDMEMBER <cap>`.
                // 2) Global deltas fan out to every socket per connection/disconnection.
                //
                // Safe because nothing in web/src or dashboard/src listens to
                // `onlineUser`, `user-online` or `user-offline` (the "online" filter
                // reads it over HTTP). The native app isn't in the repo: if it listens,
                // it keeps its snapshot and only loses live refresh above the cap.
                // Reversible via `PRESENCE_BROADCAST_MAX`.
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
