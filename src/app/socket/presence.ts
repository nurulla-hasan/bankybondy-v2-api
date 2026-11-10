/* eslint-disable no-console */
/* DISTRIBUTED PRESENCE — who is online across multiple API instances.
 * Rooms stay instance-local; Redis holds a per-instance count, mutated atomically in Lua. */
import os from 'os';
import { createClient } from 'redis';
import config from '../config';

// node-redis generics are unwieldy; use any for the glue
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let redisClient: any = null;
const localOnline = new Set<string>();

/** Global online-user Set. Key name kept: manual `SCARD online_users` numbers rely on it. */
const KEY_ONLINE = 'online_users';
/** user → number of INSTANCES holding it connected. */
const KEY_CONEXIONES = 'presence:conexiones';
/** Set of registered instance ids (sweep candidates). */
const KEY_INSTANCIAS = 'presence:instancias';
/** Sweep lease. */
const KEY_LIDER = 'presence:lider';
// Prefix kept separate: the cleanup script builds these keys inside Lua, so changing
// one side silently leaves residue behind.
const PREFIJO_INSTANCIA = 'presence:inst:';
const keyInstancia = (id: string) => `${PREFIJO_INSTANCIA}${id}`;
const keyLatido = (id: string) => `presence:latido:${id}`;

// This instance's id. The pid is deliberate: a restarted process is a NEW instance,
// so the sweep finds the previous one's trail and drains it.
const ID_INSTANCIA = `${os.hostname()}-${process.env.NODE_APP_INSTANCE ?? 'u'}-${process.pid}`;

const LATIDO_MS = 30_000;
const LATIDO_TTL_S = 90; // 3 heartbeat margins, so a long GC doesn't kill us
const BARRIDO_MS = 60_000;
const LIDER_TTL_S = 120; // > BARRIDO_MS so the leader renews before expiring
const DRENAJE_LOTE = 200; // users per SPOP pass
const REINTENTO_CONEXION_MS = 10_000;

let timerLatido: NodeJS.Timeout | null = null;
let timerBarrido: NodeJS.Timeout | null = null;
let timerReintento: NodeJS.Timeout | null = null;
let cerrando = false;
let barriendo = false; // re-entrancy guard for the sweep

// ── Lua scripts (atomic: Redis runs a whole script without interleaving) ────

/** This instance's join for a user. Returns 1 on a global offline→online.
 *  `SADD` is the lock: an instance that already contributed doesn't add again. */
const LUA_ENTRA = `
local agrego = redis.call('SADD', KEYS[1], ARGV[1])
if agrego == 0 then return 0 end
local n = redis.call('HINCRBY', KEYS[2], ARGV[1], 1)
if n <= 1 then
  redis.call('SADD', KEYS[3], ARGV[1])
  return 1
end
return 0
`;

/** This instance's leave for a user. Returns 1 on a global offline.
 *  `SREM` is the lock: only a real contributor decrements. */
const LUA_SALE = `
local saco = redis.call('SREM', KEYS[1], ARGV[1])
if saco == 0 then return 0 end
local n = redis.call('HINCRBY', KEYS[2], ARGV[1], -1)
if n <= 0 then
  redis.call('HDEL', KEYS[2], ARGV[1])
  redis.call('SREM', KEYS[3], ARGV[1])
  return 1
end
return 0
`;

/** Drains one batch of an instance's Set. `SPOP` with count reads and locks in a
 *  single atomic step, so overlapping sweeps never handle the same user. Returns
 *  how many were drained. */
const LUA_DRENA_LOTE = `
local usuarios = redis.call('SPOP', KEYS[1], tonumber(ARGV[1]))
for _, u in ipairs(usuarios) do
  local n = redis.call('HINCRBY', KEYS[2], u, -1)
  if n <= 0 then
    redis.call('HDEL', KEYS[2], u)
    redis.call('SREM', KEYS[3], u)
  end
end
return #usuarios
`;

/** Takes the sweep lease or renews it if already ours. Returns 1 if we are leader.
 *  An env-var election could yield zero leaders (instance 0 lost Redis at boot) or
 *  several (any supervisor other than PM2 leaves it undefined). */
const LUA_LIDER = `
local actual = redis.call('GET', KEYS[1])
if actual == false or actual == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
  return 1
end
return 0
`;

/** One-shot cleanup of state left by the previous version of this module. Returns
 *  -1 when it didn't apply (someone reports connections), else the orphan entries
 *  removed from `online_users`.
 *  `presence:inst:<id>` keys are built inside the script from the prefix (not known
 *  upfront), which breaks the Redis Cluster rule of declaring all keys in `KEYS` —
 *  no cluster here, noted for a future migration. */
const LUA_LIMPIAR_HUERFANOS = `
if redis.call('HLEN', KEYS[1]) > 0 then return -1 end
local ids = redis.call('SMEMBERS', KEYS[2])
for _, id in ipairs(ids) do
  redis.call('DEL', ARGV[1] .. id)
end
local n = redis.call('SCARD', KEYS[3])
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[3])
return n
`;

const correrLua = async (
    script: string,
    keys: string[],
    args: string[]
): Promise<number> => {
    const r = await redisClient.eval(script, { keys, arguments: args });
    return Number(r) || 0;
};

/** Like `correrLua` but keeps negatives: needs to tell "didn't apply" (-1) from
 *  "nothing there" (0), so it skips the `|| 0` fallback. */
const correrLuaCrudo = async (
    script: string,
    keys: string[],
    args: string[]
): Promise<number> => {
    const r = await redisClient.eval(script, { keys, arguments: args });
    const n = Number(r);
    return Number.isFinite(n) ? n : 0;
};

/** Presence Redis state for `/ready`; names no more than it checks — this client
 *  only (adapter pub/sub, BullMQ and the rate-limit store are separate, hence
 *  `redisPresencia`). `apagado` = no REDIS_URL (valid single-instance config),
 *  `listo` = connected, `caido` = configured but not operational. Uses `isReady`
 *  because `isOpen` is also true while reconnecting and rejecting commands. */
export const estadoRedisPresencia = (): 'apagado' | 'listo' | 'caido' => {
    if (!config.redis_url) return 'apagado';
    return redisClient?.isReady ? 'listo' : 'caido';
};

// ── heartbeat, leadership and sweep ─────────────────────────────────────────

const latir = async (): Promise<void> => {
    if (!redisClient) return;
    try {
        await redisClient.set(keyLatido(ID_INSTANCIA), '1', {
            EX: LATIDO_TTL_S,
        });
        // Re-register on every heartbeat, not only at startup: if the sweep wrongly
        // drained us (long failover, eviction, event loop stalled > 90 s) we'd be out
        // of the list forever, unwatched while accumulating users. This self-heals it.
        await redisClient.sAdd(KEY_INSTANCIAS, ID_INSTANCIA);
    } catch (err) {
        console.error('presencia: latido falló:', (err as Error)?.message);
    }
};

/** Drains a dead instance's trail, batch by batch. */
const drenarInstancia = async (id: string): Promise<number> => {
    if (!redisClient) return 0;
    let total = 0;
    // Hard bound so this terminates even if someone keeps adding to the Set:
    // 200 loops × 200 = 40.000 users per pass.
    for (let i = 0; i < 200; i++) {
        // eslint-disable-next-line no-await-in-loop
        const n = await correrLua(
            LUA_DRENA_LOTE,
            [keyInstancia(id), KEY_CONEXIONES, KEY_ONLINE],
            [String(DRENAJE_LOTE)]
        );
        total += n;
        if (n < DRENAJE_LOTE) break;
    }

    // No `DEL` here: it dropped members without decrementing `presence:conexiones`,
    // leaving permanent unrecoverable ghosts. `SPOP` already deletes the empty key,
    // and we unregister only when nothing is left, so the next sweep resumes the rest.
    const quedan = await redisClient.sCard(keyInstancia(id));
    if (quedan > 0) {
        console.error(
            `presencia: quedaron ${quedan} usuario(s) de ${id} sin drenar; se retoma en el próximo barrido.`
        );
        return total;
    }
    await redisClient.sRem(KEY_INSTANCIAS, id);
    return total;
};

const barrerInstanciasMuertas = async (): Promise<void> => {
    if (!redisClient || cerrando) return;
    // Re-entrancy guard: draining a large instance can overrun the minute, and its id
    // stays in `presence:instancias` until the end, so the next pass would retake it.
    if (barriendo) return;
    barriendo = true;
    try {
        const soyLider = await correrLua(
            LUA_LIDER,
            [KEY_LIDER],
            [ID_INSTANCIA, String(LIDER_TTL_S)]
        );
        if (!soyLider) return;

        const ids: string[] = await redisClient.sMembers(KEY_INSTANCIAS);
        for (const id of ids) {
            if (id === ID_INSTANCIA) continue; // we are alive
            // eslint-disable-next-line no-await-in-loop
            const vive = await redisClient.exists(keyLatido(id));
            if (vive) continue;
            // eslint-disable-next-line no-await-in-loop
            const n = await drenarInstancia(id);
            console.error(
                `presencia: instancia ${id} no late; se drenaron ${n} usuario(s).`
            );
        }
    } catch (err) {
        console.error('presencia: barrido falló:', (err as Error)?.message);
    } finally {
        barriendo = false;
    }
};

/** Startup cleanup of state left by the previous version: the instance counter starts
 *  empty after this deploy, so anything already in `online_users` would never be
 *  decremented by anyone. `HLEN == 0` is exact and needs no coordination — no instance
 *  reports a connection, so whatever is in the Set is garbage; on a rolling restart
 *  other instances do report and it's a no-op. */
const limpiarEstadoHuerfano = async (): Promise<void> => {
    if (!redisClient) return;
    try {
        // In Lua because the read-then-delete race already caused permanent damage:
        // a user connecting in between got counter 1 with no `online_users` entry, and
        // `HLEN` never returning to 0 disabled this cleanup forever. Check and delete
        // must be one operation. Returns -1 when it didn't apply, else entries removed.
        const r = await correrLuaCrudo(
            LUA_LIMPIAR_HUERFANOS,
            [KEY_CONEXIONES, KEY_INSTANCIAS, KEY_ONLINE],
            [PREFIJO_INSTANCIA]
        );
        if (r > 0) {
            console.error(
                `presencia: nadie reporta conexiones; se limpiaron ${r} entrada(s) huérfana(s) de online_users.`
            );
        }
    } catch (err) {
        console.error(
            'presencia: limpieza de arranque falló:',
            (err as Error)?.message
        );
    }
};

/** Connects (or retries) the presence client and starts heartbeat + sweep.
 *  It retries on its own: when this ran once inside the adapter `try`, a startup blip
 *  left the client null forever, silently degrading to the per-process memory Set. */
export const initPresence = async (): Promise<void> => {
    if (!config.redis_url || cerrando || redisClient) return;
    try {
        const client = createClient({ url: config.redis_url });
        client.on('error', (err) =>
            console.error('Presence Redis error:', err)
        );
        await client.connect();
        redisClient = client;

        await limpiarEstadoHuerfano();
        await latir(); // sets the heartbeat AND registers the instance

        timerLatido = setInterval(() => void latir(), LATIDO_MS);
        timerLatido.unref();
        // One pass at startup: after a crash, clean the trail now instead of in a minute.
        void barrerInstanciasMuertas();
        timerBarrido = setInterval(
            () => void barrerInstanciasMuertas(),
            BARRIDO_MS
        );
        timerBarrido.unref();
        console.log(`Presencia distribuida activa (${ID_INSTANCIA})`);
    } catch (err) {
        console.error(
            `Presence Redis no disponible; reintento en ${
                REINTENTO_CONEXION_MS / 1000
            }s:`,
            (err as Error)?.message
        );
        redisClient = null;
        if (!timerReintento) {
            timerReintento = setTimeout(() => {
                timerReintento = null;
                void initPresence();
            }, REINTENTO_CONEXION_MS);
            timerReintento.unref();
        }
    }
};

/** Graceful shutdown: this instance removes itself from shared state. This is the
 *  clean path (every deploy); the sweep covers instances without one. */
export const closePresence = async (): Promise<void> => {
    cerrando = true;
    if (timerLatido) clearInterval(timerLatido);
    if (timerBarrido) clearInterval(timerBarrido);
    if (timerReintento) clearTimeout(timerReintento);
    if (!redisClient) return;
    try {
        await drenarInstancia(ID_INSTANCIA);
        await redisClient.del(keyLatido(ID_INSTANCIA));
        await redisClient.quit();
    } catch (err) {
        console.error('presencia: cierre falló:', (err as Error)?.message);
    } finally {
        redisClient = null;
    }
};

// ── entry / exit ────────────────────────────────────────────────────────────

/** This instance now has at least one socket for `userId`.
 *  Returns whether it is the FIRST instance holding it (global offline→online). */
export const entraInstancia = async (
    userId: string
): Promise<{ primeraGlobal: boolean }> => {
    if (redisClient) {
        try {
            const r = await correrLua(
                LUA_ENTRA,
                [keyInstancia(ID_INSTANCIA), KEY_CONEXIONES, KEY_ONLINE],
                [userId]
            );
            return { primeraGlobal: r === 1 };
        } catch (err) {
            console.error('entraInstancia redis error:', err);
        }
    }
    const habia = localOnline.has(userId);
    localOnline.add(userId);
    return { primeraGlobal: !habia };
};

/** This instance has no sockets left for `userId`.
 *  Returns whether it was the LAST instance holding it (global offline). */
export const saleInstancia = async (
    userId: string
): Promise<{ ultimaGlobal: boolean }> => {
    if (redisClient) {
        try {
            const r = await correrLua(
                LUA_SALE,
                [keyInstancia(ID_INSTANCIA), KEY_CONEXIONES, KEY_ONLINE],
                [userId]
            );
            return { ultimaGlobal: r === 1 };
        } catch (err) {
            console.error('saleInstancia redis error:', err);
        }
    }
    const habia = localOnline.delete(userId);
    return { ultimaGlobal: habia };
};

// ── reads ───────────────────────────────────────────────────────────────────

/** How many are online. O(1) in Redis (`SCARD`). */
export const contarOnline = async (): Promise<number> => {
    if (redisClient) {
        try {
            return await redisClient.sCard(KEY_ONLINE);
        } catch (err) {
            console.error('contarOnline redis error:', err);
        }
    }
    return localOnline.size;
};

/** Which of THESE users are online? Exact answer, O(ids asked). Prefer it whenever a
 *  candidate list exists (e.g. proximity neighbors): no sampling, no full Set scan. */
export const filtrarOnline = async (ids: string[]): Promise<Set<string>> => {
    if (!ids.length) return new Set();
    if (redisClient) {
        try {
            const r: unknown[] = await redisClient.smIsMember(KEY_ONLINE, ids);
            const out = new Set<string>();
            r.forEach((esta, i) => {
                if (esta) out.add(ids[i]);
            });
            return out;
        } catch (err) {
            console.error('filtrarOnline redis error:', err);
        }
    }
    return new Set(ids.filter((id) => localOnline.has(id)));
};

/** A SAMPLE of up to `tope` online users; different on each call. Use only when there
 *  is no candidate list (`filtrarOnline` is exact and cheaper).
 *  Replaces a full `SMEMBERS` (O(N) on the shared single-threaded Redis, plus an
 *  equally sized Mongo `$in`). `SRANDMEMBER key <count>` is only cheap while
 *  `count * 3 <= cardinality`; what it always bounds is the response size. */
export const muestraOnline = async (tope: number): Promise<string[]> => {
    const n = Math.max(1, Math.floor(tope));
    if (redisClient) {
        try {
            return await redisClient.sRandMemberCount(KEY_ONLINE, n);
        } catch (err) {
            console.error('muestraOnline redis error:', err);
        }
    }
    return Array.from(localOnline).slice(0, n);
};
