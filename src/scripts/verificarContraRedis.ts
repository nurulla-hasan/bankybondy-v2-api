/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* Verifies presence invariants against a real Redis; the five Lua scripts are never
 * exercised by pure-function tests. Optional run; point VERIFY_REDIS_URL at a disposable instance. */
import { createClient } from 'redis';

let pass = 0;
let fail = 0;
const chequear = (nombre: string, cond: boolean, detalle?: string) => {
    if (cond) {
        pass++;
        console.log(`  OK    ${nombre}`);
    } else {
        fail++;
        console.error(`  FALLA ${nombre}${detalle ? ` → ${detalle}` : ''}`);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// The scripts, copied verbatim from presence.ts: they are private there, and
// exporting them just for a test would reshape the module. The cost is drift, so
// the last group compares this text against the real file and fails on any change.
// ─────────────────────────────────────────────────────────────────────────────
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

const LUA_LIDER = `
local actual = redis.call('GET', KEYS[1])
if actual == false or actual == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
  return 1
end
return 0
`;

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

const ONLINE = 'online_users';
const CONEX = 'presence:conexiones';
const INSTANCIAS = 'presence:instancias';
const PREFIJO = 'presence:inst:';
const LIDER = 'presence:lider';
const inst = (id: string) => `${PREFIJO}${id}`;

let redis: any;

const correr = async (script: string, keys: string[], args: string[]) =>
    Number(await redis.eval(script, { keys, arguments: args }));

const limpiar = async () => {
    const claves = await redis.keys('presence:*');
    if (claves.length) await redis.del(claves);
    await redis.del(ONLINE);
};

/** Readable state for the assertions. */
const estado = async () => ({
    online: (await redis.sMembers(ONLINE)).sort(),
    conexiones: await redis.hGetAll(CONEX),
});

// ── 1. Join and leave: the counter counts INSTANCES, not sockets ───────────
const grupoAltaBaja = async () => {
    console.log('\n── Alta y baja (el contador cuenta INSTANCIAS, no sockets)');
    await limpiar();

    const r1 = await correr(LUA_ENTRA, [inst('A'), CONEX, ONLINE], ['u1']);
    chequear('la PRIMERA instancia que lo toma devuelve 1 (pasa a online)', r1 === 1);
    chequear('y queda en online_users', (await estado()).online.includes('u1'));

    const r2 = await correr(LUA_ENTRA, [inst('B'), CONEX, ONLINE], ['u1']);
    chequear('una SEGUNDA instancia devuelve 0 (ya estaba online)', r2 === 0);
    chequear(
        'el contador llegó a 2 (dos instancias lo tienen)',
        (await estado()).conexiones.u1 === '2'
    );

    const s1 = await correr(LUA_SALE, [inst('A'), CONEX, ONLINE], ['u1']);
    chequear('la baja de UNA instancia devuelve 0 (sigue online en la otra)', s1 === 0);
    chequear(
        'NO salió de online_users: el bug que rompía el multi-instancia',
        (await estado()).online.includes('u1')
    );

    const s2 = await correr(LUA_SALE, [inst('B'), CONEX, ONLINE], ['u1']);
    chequear('la baja de la ÚLTIMA devuelve 1 (pasa a offline)', s2 === 1);
    const fin = await estado();
    chequear('salió de online_users', !fin.online.includes('u1'));
    chequear(
        'y el contador se BORRÓ (no quedó en 0 ocupando lugar)',
        fin.conexiones.u1 === undefined
    );
};

// ── 2. The exactly-once lock (the two-tabs race) ───────────────────────────
const grupoCandado = async () => {
    console.log('\n── El candado exactamente-una-vez (SADD/SREM adentro del script)');
    await limpiar();

    await correr(LUA_ENTRA, [inst('A'), CONEX, ONLINE], ['u1']);
    const repetida = await correr(LUA_ENTRA, [inst('A'), CONEX, ONLINE], ['u1']);
    chequear(
        'la MISMA instancia no puede aportar dos veces',
        repetida === 0 && (await estado()).conexiones.u1 === '1'
    );

    // The race that motivated the lock: two sockets of the same instance drop in the
    // same tick, both handlers read `room.size === 0` and both try to decrement.
    // Only one of them may succeed.
    await correr(LUA_ENTRA, [inst('B'), CONEX, ONLINE], ['u1']); // another instance
    const bajas = await Promise.all([
        correr(LUA_SALE, [inst('A'), CONEX, ONLINE], ['u1']),
        correr(LUA_SALE, [inst('A'), CONEX, ONLINE], ['u1']),
    ]);
    chequear(
        'DOS bajas simultáneas de la misma instancia restan UNA sola vez',
        (await estado()).conexiones.u1 === '1',
        `contador quedó en ${(await estado()).conexiones.u1}, bajas: ${bajas}`
    );
    chequear(
        'y el usuario sigue online (la otra instancia lo tiene)',
        (await estado()).online.includes('u1')
    );
};

// ── 3. Draining via SPOP, and the `del` hole that was removed ──────────────
const grupoDrenaje = async () => {
    console.log('\n── El drenaje de una instancia muerta (SPOP por lotes)');
    await limpiar();

    for (let i = 0; i < 5; i++) {
        await correr(LUA_ENTRA, [inst('A'), CONEX, ONLINE], [`u${i}`]);
    }
    // u0 is also in B: it must not go offline when A drains.
    await correr(LUA_ENTRA, [inst('B'), CONEX, ONLINE], ['u0']);

    const n = await correr(LUA_DRENA_LOTE, [inst('A'), CONEX, ONLINE], ['2']);
    chequear('un lote de 2 drena exactamente 2', n === 2);

    let total = n;
    for (let i = 0; i < 10; i++) {
        const m = await correr(LUA_DRENA_LOTE, [inst('A'), CONEX, ONLINE], ['2']);
        total += m;
        if (m < 2) break;
    }
    chequear('el bucle drena los 5 y termina', total === 5);
    chequear(
        'SPOP vació la clave solo (por eso el `del` sobraba)',
        (await redis.exists(inst('A'))) === 0
    );

    const fin = await estado();
    chequear(
        'u0 sigue ONLINE porque la instancia B lo tiene (no se lo llevó puesto)',
        fin.online.includes('u0') && fin.conexiones.u0 === '1'
    );
    chequear(
        'los otros cuatro quedaron offline y sin contador',
        !fin.online.includes('u1') && fin.conexiones.u1 === undefined
    );
};

// ── 4. The leader lease ────────────────────────────────────────────────────
const grupoLider = async () => {
    console.log('\n── El lease del líder (uno y sólo uno)');
    await limpiar();

    const a = await correr(LUA_LIDER, [LIDER], ['A', '120']);
    chequear('la primera instancia toma el lease', a === 1);

    const b = await correr(LUA_LIDER, [LIDER], ['B', '120']);
    chequear('una SEGUNDA no lo puede tomar mientras esté vigente', b === 0);

    const aOtraVez = await correr(LUA_LIDER, [LIDER], ['A', '120']);
    chequear('el dueño SÍ lo renueva (no se pisa a sí mismo)', aOtraVez === 1);

    const ttl = await redis.ttl(LIDER);
    chequear('el lease tiene TTL (no queda para siempre)', ttl > 0 && ttl <= 120);

    // `actual == false` is Lua's nil test: if it were wrong nobody could ever take
    // the lease and the sweep would never run across the fleet.
    await redis.del(LIDER);
    const trasVencer = await correr(LUA_LIDER, [LIDER], ['B', '120']);
    chequear(
        'vencido el lease, OTRA lo toma (el `== false` de Lua funciona)',
        trasVencer === 1
    );
};

// ── 5. Startup cleanup, and its race ──────────────────────────────────────
const grupoLimpieza = async () => {
    console.log('\n── La limpieza de arranque (atómica)');
    await limpiar();

    // Deploy residue: users in online_users with nobody reporting connections.
    await redis.sAdd(ONLINE, ['viejo1', 'viejo2']);
    await redis.sAdd(INSTANCIAS, 'muerta');
    await redis.sAdd(inst('muerta'), 'viejo1');

    const limpiados = await correr(
        LUA_LIMPIAR_HUERFANOS,
        [CONEX, INSTANCIAS, ONLINE],
        [PREFIJO]
    );
    chequear('limpia el residuo y dice cuántos sacó', limpiados === 2);
    chequear('online_users quedó vacío', (await redis.sCard(ONLINE)) === 0);
    chequear(
        'y también el rastro de la instancia muerta',
        (await redis.exists(inst('muerta'))) === 0 &&
            (await redis.exists(INSTANCIAS)) === 0
    );

    // The case that matters: with someone reporting connections it must touch nothing.
    await limpiar();
    await correr(LUA_ENTRA, [inst('viva'), CONEX, ONLINE], ['conectado']);
    const conVivos = await correr(
        LUA_LIMPIAR_HUERFANOS,
        [CONEX, INSTANCIAS, ONLINE],
        [PREFIJO]
    );
    chequear('con alguien conectado devuelve -1 y NO limpia', conVivos === -1);
    chequear(
        'el usuario conectado sigue online (no se borró presencia legítima)',
        (await redis.sMembers(ONLINE)).includes('conectado')
    );
};

// ── 6. That these scripts are still THE ONES in the code ───────────────────
const grupoSincronia = async () => {
    console.log('\n── Que los scripts probados sean los que están en presence.ts');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    // From dist/scripts/ → src/app/socket/presence.ts
    const ruta = path.resolve(
        __dirname,
        '../../src/app/socket/presence.ts'
    );
    let fuente = '';
    try {
        fuente = fs.readFileSync(ruta, 'utf8');
    } catch {
        console.log('  (no se encontró el fuente; se saltea la comparación)');
        return;
    }
    const normalizar = (s: string) => s.replace(/\s+/g, ' ').trim();
    const pares: [string, string][] = [
        ['LUA_ENTRA', LUA_ENTRA],
        ['LUA_SALE', LUA_SALE],
        ['LUA_DRENA_LOTE', LUA_DRENA_LOTE],
        ['LUA_LIDER', LUA_LIDER],
        ['LUA_LIMPIAR_HUERFANOS', LUA_LIMPIAR_HUERFANOS],
    ];
    for (const [nombre, script] of pares) {
        chequear(
            `${nombre} es idéntico al de presence.ts`,
            normalizar(fuente).includes(normalizar(script)),
            'el script del código cambió y esta prueba quedó vieja'
        );
    }
};

const main = async () => {
    const externa = process.env.VERIFY_REDIS_URL;
    let memoria: any = null;
    let url = externa;

    if (!url) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { RedisMemoryServer } = require('redis-memory-server');
        console.log('Levantando un Redis efímero…');
        memoria = new RedisMemoryServer();
        url = `redis://${await memoria.getHost()}:${await memoria.getPort()}`;
    } else {
        // ⚠️ DELETE GUARD, sibling of the Mongo one. This wipes every `presence:*`
        // key, `online_users` and `presence:lider`; against a live Redis it tears
        // down presence for whoever is connected.
        //
        // Clearing the lease only brings a takeover forward (it is atomic and
        // retried on every sweep), it does not create two leaders. The real damage
        // is presence, not the election.
        //
        // No database name to inspect as in Mongo, so the lock is an explicit
        // confirmation string nobody types by inertia. `bull:*` is untouched.
        if (process.env.VERIFY_REDIS_BORRAR !== 'si-este-redis-es-descartable') {
            console.error(
                '\n⛔ Falta la confirmación para borrar en el Redis de VERIFY_REDIS_URL.\n\n' +
                    'Esta verificación borra `presence:*`, `online_users` y el lease del\n' +
                    'líder (`presence:lider`). Contra el Redis de producción tira abajo la\n' +
                    'presencia y la elección de líder.\n\n' +
                    'Si de verdad es un Redis descartable, repetí con:\n' +
                    '  VERIFY_REDIS_BORRAR=si-este-redis-es-descartable\n'
            );
            process.exit(1);
        }
        console.log(
            'Usando el Redis de VERIFY_REDIS_URL — borrado confirmado.'
        );
    }

    redis = createClient({ url });
    redis.on('error', () => undefined);
    await redis.connect();
    const info: string = await redis.info('server');
    console.log(
        `Conectado. ${info.split('\n').find((l) => l.startsWith('redis_version'))?.trim()}`
    );

    try {
        await grupoAltaBaja();
        await grupoCandado();
        await grupoDrenaje();
        await grupoLider();
        await grupoLimpieza();
        await grupoSincronia();
        await limpiar();
    } finally {
        await redis.quit().catch(() => undefined);
        if (memoria) await memoria.stop();
    }

    console.log(`\nTOTAL: ${pass} pasaron, ${fail} fallaron`);
    if (fail) {
        console.error('\n═══ VERIFICACIÓN CONTRA REDIS: 🔴 ROJA ═══');
        process.exit(1);
    }
    console.log('\n═══ VERIFICACIÓN CONTRA REDIS: 🟢 VERDE ═══');
    process.exit(0);
};

main().catch((e: any) => {
    if (e?.code === 'MODULE_NOT_FOUND' && /redis-memory-server/.test(e?.message)) {
        console.error(
            '\nFalta `redis-memory-server`, que levanta un Redis efímero. Dos formas:\n\n' +
                '  1. npm i --no-save redis-memory-server   (no toca package.json)\n' +
                '  2. VERIFY_REDIS_URL=redis://host:6379 VERIFY_REDIS_BORRAR=si-este-redis-es-descartable node dist/scripts/verificarContraRedis.js\n' +
                '     (staging o el entorno de carga; NUNCA producción: esto BORRA\n' +
                '      las claves de presencia)\n'
        );
        process.exit(1);
    }
    console.error('La verificación no pudo correr:', e);
    process.exit(1);
});
