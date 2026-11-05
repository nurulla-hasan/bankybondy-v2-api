/* eslint-disable no-console */
/* PRESENCIA DISTRIBUIDA — quién está conectado, con varias instancias de la API.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * QUÉ ESTABA MAL (T5 del plan, y estaba escrito en el propio socket.ts)
 *
 * La versión anterior decidía "¿se conectó por primera vez?" y "¿se fue el
 * último?" mirando `io.sockets.adapter.rooms`, que es **LOCAL a la instancia**,
 * pero escribía sobre un Set de Redis **COMPARTIDO**. Con una sola instancia eso
 * era correcto. Con dos, cerrar la pestaña en la instancia A mientras B sigue
 * conectada daba `room.size === 0` local → borraba al usuario del Set GLOBAL y
 * emitía 'user-offline' a todos. No es un duplicado inocuo: corrompe estado
 * compartido y deja un falso-offline persistente, que además ensucia el filtro
 * "online" de Personas.
 *
 * O sea: subir `WEB_CONCURRENCY` estaba a una variable de entorno de romper la
 * presencia, sin ninguna guarda en el código. Esto es lo que lo desbloquea.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EL DISEÑO: EL CONTADOR CUENTA INSTANCIAS, NO SOCKETS
 *
 * Dentro de UNA instancia, `adapter.rooms` SÍ es autoridad —es exactamente lo que
 * es— así que cada instancia resuelve sola cuántos sockets tiene de un usuario.
 * Lo único que no puede saber sola es si OTRA instancia también lo tiene.
 *
 * Entonces cada instancia aporta **como mucho 1** al contador global. La
 * alternativa —contar SOCKETS— obligaba a guardar un contador por (instancia,
 * usuario) para poder revertir bien una caída; contando instancias alcanza con un
 * Set por instancia.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TODO CAMBIO DE ESTADO VA EN UN SCRIPT LUA, Y ESO NO ES ADORNO
 *
 * Cada transición toca TRES claves (el Set de la instancia, el contador global y
 * `online_users`). Hechas como comandos sueltos, node-redis rechaza **todas las
 * promesas en vuelo** ante cualquier error de socket —está medido y escrito en
 * `server.ts`— así que un parpadeo podía dejar el par partido al medio:
 *
 *   · `SREM` ok + `HINCRBY` falla → el usuario salió del Set de la instancia pero
 *     el contador conserva su +1. **Fantasma PERMANENTE e irreparable**: ya no
 *     está en ningún `presence:inst:*`, así que ni el barrido lo puede arreglar.
 *   · `SADD` ok + `HINCRBY` falla → la instancia figura aportando sin haber
 *     sumado; la baja posterior resta de más y puede marcar offline a alguien
 *     conectado en OTRA instancia.
 *
 * Con Lua las tres claves se mueven juntas o no se mueve ninguna, y de paso el
 * valor de retorno de `SADD`/`SREM` funciona como candado EXACTAMENTE-UNA-VEZ
 * dentro del mismo script: dos pestañas que se caen en el mismo tick salen las
 * dos del room antes de que corra ningún handler, los dos handlers ven
 * `size === 0` y los dos intentan restar — y sólo uno lo logra.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FANTASMAS: CUANDO UNA INSTANCIA SE MUERE SIN AVISAR
 *
 * Cada instancia late (`presence:latido:<id>`, TTL 90 s, refrescado cada 30) y
 * anota sus usuarios en `presence:inst:<id>`. Un líder barre cada minuto las
 * instancias registradas y, a la que no late, le DRENA su Set.
 *
 * Tres decisiones que salieron del panel del 11/9:
 *
 *  · **El drenaje usa `SPOP` por lotes, no `SMEMBERS`.** `SMEMBERS` traía la lista
 *    COMPLETA —justo el comando O(N) que esta tanda vino a sacar— y en el peor
 *    momento posible: la instancia acaba de morir y sus usuarios están
 *    reconectándose en manada contra las sobrevivientes. `SPOP` con count saca y
 *    devuelve en un solo paso atómico, así que además ES el candado: dos drenajes
 *    solapados no pueden agarrar al mismo usuario.
 *  · **El latido RE-REGISTRA la instancia.** Antes el `SADD` a `presence:instancias`
 *    sólo ocurría al arrancar, así que si el barrido drenaba por error a una
 *    instancia VIVA (Redis con failover de más de 90 s, una evicción, el event
 *    loop trabado), esa instancia quedaba fuera de la lista PARA SIEMPRE: seguía
 *    trabajando pero ya nadie la vigilaba, y cuando se muriera de verdad sus
 *    fantasmas no los levantaba nadie.
 *  · **El líder del barrido se elige con un LEASE en Redis, no con la variable de
 *    entorno.** Para los cron y las migraciones, "corre de más" es inofensivo; acá
 *    significa drenajes concurrentes. Y al revés: si a la instancia 0 le toca un
 *    parpadeo de Redis al arrancar, con la variable de entorno NADIE barre en toda
 *    la flota y nada lo dice. El lease garantiza uno, y exactamente uno.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SIN REDIS todo esto queda en un Set en memoria, single-instance, como siempre.
 */
import os from 'os';
import { createClient } from 'redis';
import config from '../config';

// node-redis genera tipos genéricos complejos; usamos any para el glue
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let redisClient: any = null;
const localOnline = new Set<string>();

/** Set GLOBAL de usuarios online. Se conserva el nombre de siempre: hay
 *  mediciones hechas a mano contra esta clave (`SCARD online_users`) y no hay
 *  ninguna razón para invalidarlas. */
const KEY_ONLINE = 'online_users';
/** Hash usuario → cuántas INSTANCIAS lo tienen conectado. */
const KEY_CONEXIONES = 'presence:conexiones';
/** Set de los ids de instancia registrados (para saber a quién barrer). */
const KEY_INSTANCIAS = 'presence:instancias';
/** Lease del que barre. */
const KEY_LIDER = 'presence:lider';
// El prefijo va aparte porque el script de limpieza construye estas claves
// adentro de Lua: si se cambia acá y no allá, la limpieza dejaría de encontrarlas
// y el residuo del deploy volvería en silencio.
const PREFIJO_INSTANCIA = 'presence:inst:';
const keyInstancia = (id: string) => `${PREFIJO_INSTANCIA}${id}`;
const keyLatido = (id: string) => `presence:latido:${id}`;

// Id de ESTA instancia. Lleva el pid a propósito: un proceso reiniciado es una
// instancia NUEVA, y así el barrido encuentra el rastro del anterior y lo limpia.
const ID_INSTANCIA = `${os.hostname()}-${process.env.NODE_APP_INSTANCE ?? 'u'}-${process.pid}`;

const LATIDO_MS = 30_000;
const LATIDO_TTL_S = 90; // 3 latidos de margen: un GC largo no tiene que matarnos
const BARRIDO_MS = 60_000;
const LIDER_TTL_S = 120; // > BARRIDO_MS para que el líder renueve antes de vencer
const DRENAJE_LOTE = 200; // usuarios por pasada de SPOP
const REINTENTO_CONEXION_MS = 10_000;

let timerLatido: NodeJS.Timeout | null = null;
let timerBarrido: NodeJS.Timeout | null = null;
let timerReintento: NodeJS.Timeout | null = null;
let cerrando = false;
let barriendo = false; // anti-reentrada del barrido

// ── scripts Lua (atómicos por definición: Redis corre un script entero sin
//    interleaving) ──────────────────────────────────────────────────────────

/** Alta de ESTA instancia para un usuario. Devuelve 1 si el usuario pasa de
 *  offline a online a nivel GLOBAL. El `SADD` es el candado: si esta instancia ya
 *  aportaba, no vuelve a sumar. */
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

/** Baja de ESTA instancia para un usuario. Devuelve 1 si el usuario queda offline
 *  a nivel GLOBAL. El `SREM` es el candado: sólo resta quien de verdad aportaba. */
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

/** Drena un LOTE del Set de una instancia. `SPOP` con count saca y devuelve en un
 *  solo paso atómico, así que es a la vez la lectura y el candado: dos drenajes
 *  solapados nunca procesan al mismo usuario. Devuelve cuántos drenó. */
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

/** Toma el lease del barrido, o lo renueva si ya es nuestro. Devuelve 1 si somos
 *  el líder. Sin esto la elección dependía de una variable de entorno, que puede
 *  dar CERO líderes (si a la instancia 0 le falla Redis al arrancar) o VARIOS
 *  (cualquier supervisor que no sea PM2 deja la variable sin definir en todas). */
const LUA_LIDER = `
local actual = redis.call('GET', KEYS[1])
if actual == false or actual == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
  return 1
end
return 0
`;

/** Limpieza del estado que quedó de la versión ANTERIOR del módulo, en un solo
 *  paso atómico. Devuelve -1 si NO correspondía limpiar (alguien reporta
 *  conexiones), o cuántas entradas huérfanas sacó de `online_users`.
 *
 *  El `KEYS`/`ARGV` acá tiene una particularidad: los `presence:inst:<id>` se
 *  construyen DENTRO del script a partir del prefijo, porque no se conocen de
 *  antemano. Eso rompería la regla de Redis Cluster de declarar todas las claves
 *  en `KEYS`; no corremos cluster y queda dicho para que nadie se sorprenda si
 *  algún día se migra. */
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

/** Igual que `correrLua` pero conserva los negativos. `correrLua` usa
 *  `Number(r) || 0`, que convierte -1 en -1 (bien) pero también 0 en 0; acá
 *  hace falta distinguir "no correspondía" (-1) de "no había nada" (0), así que
 *  no se puede usar el `||`. */
const correrLuaCrudo = async (
    script: string,
    keys: string[],
    args: string[]
): Promise<number> => {
    const r = await redisClient.eval(script, { keys, arguments: args });
    const n = Number(r);
    return Number.isFinite(n) ? n : 0;
};

/** Estado del Redis de presencia, para `/ready`.
 *
 *  ⚠️ ALCANCE, para que el nombre no prometa de más: esto mira ÚNICAMENTE el
 *  cliente de presencia. En el proceso conviven además el pub/sub del adapter de
 *  socket.io, la conexión ioredis de BullMQ y el store de rate-limit. Por eso en
 *  `/ready` el campo se llama `redisPresencia` y no `redis`.
 *
 *  Tres valores distintos a propósito:
 *   - `apagado`: no hay REDIS_URL. Es una CONFIGURACIÓN válida (single-instance
 *     con Set en memoria), no una falla.
 *   - `listo`:   cliente conectado y aceptando comandos.
 *   - `caido`:   hay REDIS_URL pero el cliente no está operativo.
 *
 *  `isReady` y no `isOpen`: `isOpen` es cierto también mientras el cliente
 *  reconecta y todavía rechaza comandos. */
export const estadoRedisPresencia = (): 'apagado' | 'listo' | 'caido' => {
    if (!config.redis_url) return 'apagado';
    return redisClient?.isReady ? 'listo' : 'caido';
};

// ── latido, liderazgo y barrido ─────────────────────────────────────────────

const latir = async (): Promise<void> => {
    if (!redisClient) return;
    try {
        await redisClient.set(keyLatido(ID_INSTANCIA), '1', {
            EX: LATIDO_TTL_S,
        });
        // RE-REGISTRO en cada latido, no sólo al arrancar. Si el barrido llegara a
        // drenarnos por error —Redis con failover largo, una evicción, el event
        // loop trabado más de 90 s— el `sRem` de `KEY_INSTANCIAS` nos sacaría de la
        // lista y nadie nos volvería a mirar NUNCA, aunque siguiéramos vivos y
        // acumulando usuarios. Con esto el registro se auto-repara.
        await redisClient.sAdd(KEY_INSTANCIAS, ID_INSTANCIA);
    } catch (err) {
        console.error('presencia: latido falló:', (err as Error)?.message);
    }
};

/** Drena el rastro de una instancia muerta, de a lotes. */
const drenarInstancia = async (id: string): Promise<number> => {
    if (!redisClient) return 0;
    let total = 0;
    // Cota dura para que esto termine aunque alguien siga agregando al Set
    // mientras drenamos: 200 vueltas × 200 = 40.000 usuarios por pasada.
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

    // ⚠️ ACÁ HABÍA UN `del(keyInstancia(id))` Y ERA UN AGUJERO GRAVE.
    //
    // `DEL` saca a los miembros del Set **sin decrementar `presence:conexiones`**.
    // O sea que en los dos casos en que el bucle no vacía el Set —se agota por la
    // cota de 200 vueltas, o la instancia "muerta" resucita y sigue agregando— ese
    // `DEL` borraba el rastro de gente cuyo aporte al contador global quedaba
    // puesto PARA SIEMPRE, y encima irreparable: ya no están en ningún
    // `presence:inst:*`, así que ningún barrido futuro los puede encontrar.
    //
    // Era, exactamente, el "fantasma permanente e irreparable" que el encabezado
    // de este módulo dice que los scripts Lua vuelven imposible. Lo reintroducía
    // una línea escrita para "limpiar prolijo".
    //
    // Y el comentario que lo acompañaba —"lo que sobre queda para la siguiente"—
    // era falso: el `sRem` de abajo desregistraba la instancia, así que no había
    // ninguna pasada siguiente.
    //
    // `SPOP` ya borra la clave solo cuando la vacía, así que el `DEL` nunca hizo
    // falta. Y la instancia se desregistra SÓLO si de verdad no queda nadie: si
    // sobró algo, sigue en el registro y el próximo barrido la retoma — que es lo
    // que el comentario decía y ahora hace.
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
    // Anti-reentrada: drenar una instancia con muchos usuarios puede pasarse del
    // minuto, y el id sigue en `presence:instancias` hasta el final, así que la
    // pasada siguiente lo volvería a tomar.
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
            if (id === ID_INSTANCIA) continue; // nosotros estamos vivos
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

/** Limpieza de arranque para el estado que quedó de la versión ANTERIOR.
 *
 *  El modelo cambió: ahora un id sale de `online_users` sólo cuando el contador
 *  de instancias llega a 0. Después de este deploy, ese contador arranca VACÍO,
 *  así que todo lo que ya estuviera en `online_users` no lo iba a decrementar
 *  NADIE NUNCA — incluidos todos los que estén conectados en el momento del
 *  deploy, cuyos sockets mueren con el proceso viejo.
 *
 *  La condición `HLEN == 0` es exacta y no hace falta ninguna coordinación: si
 *  ninguna instancia reporta una sola conexión, entonces nadie puede estar
 *  online, y lo que haya en el Set es basura. En un reinicio rotativo donde otras
 *  instancias sí tienen gente, `HLEN > 0` y esto no toca nada. */
const limpiarEstadoHuerfano = async (): Promise<void> => {
    if (!redisClient) return;
    try {
        // VA EN LUA, y la razón es una carrera que YA producía daño permanente.
        //
        // La versión anterior hacía esto en cuatro viajes separados: leía `HLEN`,
        // decidía, y RECIÉN DESPUÉS borraba. La condición era exacta en el
        // instante de leerla, pero los borrados llegaban decenas de milisegundos
        // más tarde y no estaban condicionados a nada. En el medio entraba esto:
        //
        //   · **Alguien se conecta** a una instancia viva (un reinicio rotativo
        //     alcanza): `LUA_ENTRA` lo mete en `presence:inst:A`, le pone el
        //     contador en 1 y lo agrega a `online_users`. Después el arranque
        //     borra las dos claves. Queda con contador 1, fuera de `online_users`
        //     y sin instancia que lo reclame: figura offline estando conectado, al
        //     desconectarse su `SREM` no matchea nada, y **el contador queda
        //     clavado en 1 para siempre**. Peor: como `HLEN` nunca vuelve a 0,
        //     esta limpieza NO SE EJECUTA NUNCA MÁS en la vida del sistema.
        //   · **Dos instancias arrancando** ven las dos `HLEN == 0` y las dos
        //     borran, destruyéndose mutuamente el registro.
        //
        // Con el script, la comprobación y los borrados son una sola operación:
        // no hay ventana donde meterse. Devuelve -1 si no correspondía limpiar, o
        // cuántas entradas huérfanas sacó.
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

/** Conecta (o reconecta) el cliente de presencia y arranca latido + barrido.
 *
 *  ⚠️ REINTENTA. Antes esto se llamaba UNA vez, adentro del `try` del adapter, y
 *  si Redis tenía un hipo justo en el arranque —que es cuando más reinicios hay—
 *  el cliente quedaba `null` PARA SIEMPRE: la presencia caía al Set en memoria de
 *  cada proceso, que con multi-instancia es exactamente la corrupción que este
 *  módulo existe para hacer imposible. Y nada lo decía: `/ready` reportaba
 *  `caido` eternamente aunque Redis hubiera vuelto hacía horas. */
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
        await latir(); // deja el latido puesto Y registra la instancia

        timerLatido = setInterval(() => void latir(), LATIDO_MS);
        timerLatido.unref();
        // Una pasada al arrancar: si veníamos de una caída, limpia ya el rastro
        // en vez de esperar el primer minuto.
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

/** Apagado ordenado: esta instancia se borra a sí misma del estado compartido.
 *  Es el camino LIMPIO (cada deploy pasa por acá); el barrido es para cuando no
 *  hay apagado ordenado que valga. */
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

// ── entrada / salida ────────────────────────────────────────────────────────

/** ESTA instancia pasó a tener al menos un socket de `userId`.
 *  Devuelve si es la PRIMERA instancia que lo tiene (o sea: el usuario pasa de
 *  offline a online a nivel global). */
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

/** ESTA instancia se quedó sin sockets de `userId`.
 *  Devuelve si era la ÚLTIMA instancia que lo tenía (el usuario pasa a offline). */
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

// ── lectura ─────────────────────────────────────────────────────────────────

/** Cuántos hay online. O(1) en Redis (`SCARD`). */
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

/** ¿Cuáles de ESTOS usuarios están online? Respuesta EXACTA y O(cantidad pedida).
 *
 *  Es la lectura que hay que preferir siempre que ya se tenga una lista de
 *  candidatos (por ejemplo los vecinos del filtro de cercanía): no muestrea, no
 *  recorre el Set, y no tiene ninguno de los problemas de la muestra. */
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

/** Una MUESTRA de hasta `tope` usuarios online.
 *
 *  ⚠️ Es una MUESTRA, y cada llamada devuelve una distinta. Úsese sólo cuando NO
 *  hay una lista de candidatos (si la hay, `filtrarOnline` es exacta y más barata).
 *
 *  Reemplaza a un `SMEMBERS` del Set entero, que es O(N) sobre un Redis de un solo
 *  hilo —el mismo que atiende BullMQ, los rate limits y el adapter de sockets— y
 *  cuyo resultado además iba a un `$in` de Mongo con esa misma cantidad de ids.
 *
 *  PRECISIÓN sobre el costo, que una versión anterior de este comentario decía
 *  mal: `SRANDMEMBER key <count>` **no siempre** evita recorrer el Set. Redis usa
 *  la estrategia barata sólo cuando `count * 3 <= cardinalidad`; por debajo de eso
 *  copia el Set a una estructura temporal. O sea que en la zona de transición
 *  (hasta ~3× el tope) cuesta parecido a `SMEMBERS`. Lo que SÍ acota siempre, y es
 *  lo que importa acá, es el TAMAÑO de la respuesta y del `$in` que va a Mongo. */
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
