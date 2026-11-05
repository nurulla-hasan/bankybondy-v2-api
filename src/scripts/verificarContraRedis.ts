/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* VERIFICACIÓN DE LA PRESENCIA CONTRA UN REDIS REAL.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POR QUÉ EXISTE
 *
 * `presence.ts` se reescribió ENTERO y toda su corrección descansa en CINCO
 * scripts Lua que, hasta este archivo, **nunca se habían ejecutado**. Ni una vez.
 * El typecheck no mira adentro de un string, y los 275 tests del gate son
 * funciones puras que no tocan Redis.
 *
 * Es exactamente la misma clase de riesgo que en Mongo destapó el bug de
 * `matchesGen` —lógica razonada y nunca corrida— y esa clase ya demostró que
 * muerde. Acá el costo de equivocarse es más alto todavía: un contador mal llevado
 * deja gente marcada online para siempre, o marca offline a alguien conectado.
 *
 * NO se prueba "que Redis funcione": se prueban LAS INVARIANTES del diseño, que
 * son las que el panel de refutadores atacó una por una.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * CÓMO SE CORRE
 *
 *   # contra un Redis efímero que se levanta y se tira solo:
 *   #   npm i --no-save redis-memory-server
 *   node dist/scripts/verificarContraRedis.js
 *
 *   # o contra un Redis de verdad (staging o el entorno de carga; NUNCA
 *   # producción, porque esto BORRA las claves de presencia):
 *   VERIFY_REDIS_URL=redis://host:6379 VERIFY_REDIS_BORRAR=si-este-redis-es-descartable node dist/scripts/verificarContraRedis.js
 *
 * NO se agrega al gate: el gate tiene que poder correr sin infraestructura.
 */
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
// LOS SCRIPTS, COPIADOS TAL CUAL DE presence.ts.
//
// Se copian a propósito en vez de importarlos: `presence.ts` los tiene privados
// y exportarlos sólo para el test cambiaría el módulo para acomodar la prueba.
// El precio es que pueden divergir — por eso el último grupo COMPARA el texto de
// estos scripts contra el archivo real y falla si alguien tocó uno solo.
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

/** Estado legible, para las aserciones. */
const estado = async () => ({
    online: (await redis.sMembers(ONLINE)).sort(),
    conexiones: await redis.hGetAll(CONEX),
});

// ── 1. Alta y baja: el caso simple, y que el contador cuente INSTANCIAS ─────
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

// ── 2. El candado exactamente-una-vez (la carrera de las dos pestañas) ─────
const grupoCandado = async () => {
    console.log('\n── El candado exactamente-una-vez (SADD/SREM adentro del script)');
    await limpiar();

    await correr(LUA_ENTRA, [inst('A'), CONEX, ONLINE], ['u1']);
    const repetida = await correr(LUA_ENTRA, [inst('A'), CONEX, ONLINE], ['u1']);
    chequear(
        'la MISMA instancia no puede aportar dos veces',
        repetida === 0 && (await estado()).conexiones.u1 === '1'
    );

    // LA CARRERA QUE MOTIVÓ EL CANDADO: dos sockets de la misma instancia se
    // caen en el mismo tick, los dos handlers leen `room.size === 0` y los dos
    // intentan restar. Sólo uno tiene que lograrlo.
    await correr(LUA_ENTRA, [inst('B'), CONEX, ONLINE], ['u1']); // otra instancia
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

// ── 3. El drenaje por SPOP, y el agujero del `del` que se sacó ──────────────
const grupoDrenaje = async () => {
    console.log('\n── El drenaje de una instancia muerta (SPOP por lotes)');
    await limpiar();

    for (let i = 0; i < 5; i++) {
        await correr(LUA_ENTRA, [inst('A'), CONEX, ONLINE], [`u${i}`]);
    }
    // u0 también está en B: no tiene que quedar offline al drenar A.
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

// ── 4. El lease del líder ──────────────────────────────────────────────────
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

    // `actual == false` es el test de nil de Lua: si estuviera mal, nadie podría
    // tomar el lease NUNCA y el barrido no correría en toda la flota.
    await redis.del(LIDER);
    const trasVencer = await correr(LUA_LIDER, [LIDER], ['B', '120']);
    chequear(
        'vencido el lease, OTRA lo toma (el `== false` de Lua funciona)',
        trasVencer === 1
    );
};

// ── 5. La limpieza de arranque, y su carrera ───────────────────────────────
const grupoLimpieza = async () => {
    console.log('\n── La limpieza de arranque (atómica)');
    await limpiar();

    // Residuo del deploy: gente en online_users sin que nadie reporte conexiones.
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

    // EL CASO QUE IMPORTA: si alguien reporta conexiones, NO tiene que tocar nada.
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

// ── 6. Que estos scripts sigan siendo LOS DEL CÓDIGO ───────────────────────
const grupoSincronia = async () => {
    console.log('\n── Que los scripts probados sean los que están en presence.ts');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    // Desde dist/scripts/ → src/app/socket/presence.ts
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
        // ⚠️ GUARDA DE BORRADO, hermana de la de `verificarContraMongo`. Esta
        // verificación borra TODAS las claves `presence:*`, el conjunto
        // `online_users` y `presence:lider`, el lease de la elección de líder.
        // Contra el Redis vivo desarma la presencia de quien esté conectado.
        //
        // Sobre el lease: una versión anterior de este comentario decía que
        // borrarlo abre una ventana de dos líderes. El panel del 26/9 lo desmintió
        // leyendo el Lua: la toma es ATÓMICA y se reintenta en cada barrido, así
        // que borrarlo ADELANTA una toma, no duplica líderes. El daño real es la
        // presencia, no la elección.
        //
        // No hay nombre de base que mirar como en Mongo, así que el candado es la
        // confirmación explícita: una cadena que nadie tipea por inercia.
        //
        // (No toca `bull:*`: la cola de matcheo no está en riesgo por este script.)
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
