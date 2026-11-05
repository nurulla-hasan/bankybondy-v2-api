/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* VERIFICACIÓN CONTRA UNA BASE REAL — lo que los 275 tests NO pueden probar.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POR QUÉ EXISTE
 *
 * El gate corre 275 tests y todos son de FUNCIONES PURAS: aritmética del scoring,
 * clamps, políticas. Ninguno toca la base. Y esta tanda cambió, sobre todo,
 * CONSULTAS: la forma del filtro del sweep, un índice nuevo, una guarda que vive
 * en el filtro de un `updateOne`, una migración, y semántica de MongoDB que se
 * razonó pero nunca se ejecutó.
 *
 * Esa distinción no es teórica: en esta misma tanda, el defecto más grave del
 * motor fue exactamente eso — `{ matchesGen: 0 }` NO matchea un campo ausente.
 * Se razonó mal, el typecheck no lo ve, los 275 tests no lo ven, y habría matado
 * el matcheo de fondo el día del deploy. Este archivo es la red para esa clase.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * CÓMO SE CORRE
 *
 *   # contra un Mongo efímero que se levanta y se tira solo (necesita
 *   # `npm i --no-save mongodb-memory-server`):
 *   node dist/scripts/verificarContraMongo.js
 *
 *   # o contra un Mongo de verdad (staging, el entorno de carga, NUNCA producción):
 *   VERIFY_MONGO_URL=mongodb://host/bankybondy-verify-descartable VERIFY_MONGO_BORRAR=si-esta-base-es-descartable node dist/scripts/verificarContraMongo.js
 *
 * NO se agrega al gate: el gate tiene que poder correr sin infraestructura. Esto
 * se corre ANTES DE CADA DEPLOY que toque consultas, y en el entorno de carga.
 *
 * Sale con código 1 si algo falla, así que encadena en un script.
 */
import mongoose from 'mongoose';

// Los modelos y la lógica REAL, no copias.
import BondRequest from '../app/modules/bondRequest/bondRequest.model';
import NormalUser from '../app/modules/normalUser/normalUser.model';
import Transaction from '../app/modules/transaction/transaction.model';
import { ENUM_BOND_REQUEST_STATUS } from '../app/modules/bondRequest/bondRequest.enum';
import { agendaVencida } from '../app/modules/bondRequest/matching.schedule';
import { backfillAgendaMatcheo } from '../app/modules/bondRequest/backfillAgendaMatcheo';
import {
    PLANES,
    tiposHastaNivelDe,
    type TipoPlan,
} from '../app/modules/normalUser/subscriptionPlans';

let pass = 0;
let fail = 0;
const chequear = (nombre: string, condicion: boolean, detalle?: string) => {
    if (condicion) {
        pass++;
        console.log(`  OK    ${nombre}`);
    } else {
        fail++;
        console.error(`  FALLA ${nombre}${detalle ? ` → ${detalle}` : ''}`);
    }
};

const oid = () => new mongoose.Types.ObjectId();

/** Un vínculo mínimo que pasa las validaciones del modelo. */
const bondBase = (extra: Record<string, unknown> = {}) => ({
    user: oid(),
    offer: 'clases de guitarra',
    want: 'una bici',
    offerVector: [0.1, 0.2],
    wantVector: [0.3, 0.4],
    ...extra,
});

// ── 1. La semántica de Mongo que casi nos cuesta el matcheo de fondo ────────
const grupoSemanticaDeAusentes = async () => {
    console.log('\n── Semántica de campos AUSENTES (la clase del bug de matchesGen)');
    const col = mongoose.connection.collection('probaAusentes');
    await col.deleteMany({});
    const idSin = oid();
    const idCon = oid();
    // Se insertan por el DRIVER, no por mongoose: así el documento queda de
    // verdad SIN el campo, igual que un documento legado.
    await col.insertMany([
        { _id: idSin as any, nombre: 'sin campo' },
        { _id: idCon as any, nombre: 'con cero', matchesGen: 0 },
    ]);

    const porCero = await col.countDocuments({ matchesGen: 0 });
    chequear(
        'igualdad `{campo: 0}` NO matchea un documento sin el campo',
        porCero === 1,
        `matcheó ${porCero}, esperado 1`
    );

    const porInCeroNull = await col.countDocuments({
        matchesGen: { $in: [0, null] },
    });
    chequear(
        '`$in: [0, null]` SÍ matchea el ausente Y el cero (la guarda del sellado)',
        porInCeroNull === 2,
        `matcheó ${porInCeroNull}, esperado 2`
    );

    const porLte = await col.countDocuments({ matchesNextAt: { $lte: new Date() } });
    chequear(
        '`$lte` NO matchea un campo ausente (por eso el centinela, no `$exists`)',
        porLte === 0,
        `matcheó ${porLte}, esperado 0`
    );
    await col.drop().catch(() => undefined);
};

// ── 2. La consulta del sweep: ¿el índice provee filtro Y ORDEN? ─────────────
const grupoSweep = async () => {
    console.log('\n── La consulta del sweep y su índice (el SORT bloqueante)');
    await BondRequest.deleteMany({});
    await BondRequest.syncIndexes();

    const ahora = Date.now();
    await BondRequest.create([
        bondBase({ matchesNextAt: new Date(ahora - 90_000) }), // vencido hace rato
        bondBase({ matchesNextAt: agendaVencida() }), // centinela: el más vencido
        bondBase({ matchesNextAt: new Date(ahora + 3_600_000) }), // futuro: NO va
        bondBase({ matchesNextAt: agendaVencida(), isPause: true }), // pausado: NO va
    ] as any);

    const filtro = {
        status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
        isPause: false,
        isLinked: false,
        matchesNextAt: { $lte: new Date() },
    };

    const plan: any = await BondRequest.find(filtro)
        .sort({ matchesNextAt: 1 })
        .limit(1500)
        .select('_id')
        .explain('queryPlanner');

    const etapas = JSON.stringify(plan?.queryPlanner?.winningPlan ?? plan);
    chequear(
        'el plan NO tiene una etapa SORT bloqueante (el índice da el orden)',
        !etapas.includes('"SORT"'),
        `plan: ${etapas.slice(0, 220)}`
    );
    chequear(
        'el plan usa un IXSCAN (no un COLLSCAN)',
        etapas.includes('IXSCAN'),
        `plan: ${etapas.slice(0, 220)}`
    );

    const encontrados = await BondRequest.find(filtro)
        .sort({ matchesNextAt: 1 })
        .select('matchesNextAt')
        .lean();
    chequear(
        'trae exactamente los 2 elegibles (no el futuro ni el pausado)',
        encontrados.length === 2,
        `trajo ${encontrados.length}`
    );
    chequear(
        'el centinela (época) queda PRIMERO en el orden',
        encontrados.length === 2 &&
            new Date((encontrados[0] as any).matchesNextAt).getTime() === 0,
        `primero: ${(encontrados[0] as any)?.matchesNextAt}`
    );
};

// ── 3. La migración de arranque, contra documentos legados de verdad ────────
const grupoBackfill = async () => {
    console.log('\n── El backfill (contra documentos legados REALES)');
    await BondRequest.deleteMany({});
    const col = mongoose.connection.collection('bondrequests');
    const id = oid();
    // Documento legado: insertado por el driver, sin los campos nuevos.
    await col.insertOne({
        _id: id as any,
        user: oid(),
        offer: 'algo',
        want: 'otra cosa',
        offerVector: [0.1],
        wantVector: [0.2],
        status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
        createdAt: new Date(),
        updatedAt: new Date(Date.now() - 90 * 86400_000), // 90 días atrás
    } as any);

    const antes: any = await col.findOne({ _id: id as any });
    chequear(
        'el documento legado arranca SIN matchesNextAt, matchesGen, isPause ni isLinked',
        antes.matchesNextAt === undefined &&
            antes.matchesGen === undefined &&
            antes.isPause === undefined &&
            antes.isLinked === undefined
    );

    await backfillAgendaMatcheo();

    const despues: any = await col.findOne({ _id: id as any });
    chequear(
        'el backfill siembra los CUATRO campos',
        despues.matchesNextAt instanceof Date &&
            despues.matchesGen === 0 &&
            despues.isPause === false &&
            despues.isLinked === false,
        JSON.stringify({
            matchesNextAt: despues.matchesNextAt,
            matchesGen: despues.matchesGen,
            isPause: despues.isPause,
            isLinked: despues.isLinked,
        })
    );
    chequear(
        'la agenda sembrada está VENCIDA (elegible ya)',
        new Date(despues.matchesNextAt).getTime() === 0
    );
    chequear(
        'NO le movió `updatedAt` (la contabilidad no puede tocar el ranking)',
        new Date(despues.updatedAt).getTime() ===
            new Date(antes.updatedAt).getTime(),
        `antes ${antes.updatedAt} / después ${despues.updatedAt}`
    );

    // Idempotencia: correrlo de nuevo no cambia nada.
    await backfillAgendaMatcheo();
    const tercera: any = await col.findOne({ _id: id as any });
    chequear(
        'es idempotente (correrlo dos veces no cambia nada)',
        new Date(tercera.updatedAt).getTime() ===
            new Date(antes.updatedAt).getTime() && tercera.matchesGen === 0
    );
};

// ── 4. La guarda anti-downgrade, ejecutada de verdad ────────────────────────
const grupoAntiDowngrade = async () => {
    console.log('\n── La guarda anti-downgrade (el filtro atómico, ejecutado)');
    await NormalUser.deleteMany({});

    const filtroDe = (tipo: TipoPlan) => ({
        $nin: (Object.keys(PLANES) as TipoPlan[]).filter(
            (t) => PLANES[t].nivel > PLANES[tipo].nivel
        ),
    });

    const aplicar = async (userId: any, tipo: TipoPlan) => {
        const r = await NormalUser.updateOne(
            { _id: userId, subscriptionType: filtroDe(tipo) },
            {
                $set: {
                    subscriptionType: tipo,
                    bondLimit: PLANES[tipo].bondLimit,
                },
            }
        );
        return r.matchedCount > 0;
    };

    const crear = async (tipo?: any) => {
        const u = await NormalUser.create({
            user: oid(),
            name: 'x',
            email: `${oid()}@x.com`,
            ...(tipo !== undefined ? { subscriptionType: tipo } : {}),
        } as any);
        return u._id;
    };

    const premium = await crear('Premium');
    chequear(
        'un pago STANDARD **no** puede pisar un PREMIUM (el caso que motivó todo)',
        (await aplicar(premium, 'Standard')) === false
    );
    chequear(
        'y el Premium quedó intacto',
        (await NormalUser.findById(premium).lean<any>())?.subscriptionType ===
            'Premium'
    );

    const free = await crear('Free');
    chequear('un Free SÍ puede subir a Standard', await aplicar(free, 'Standard'));
    chequear(
        'y le quedó el bondLimit del plan',
        (await NormalUser.findById(free).lean<any>())?.bondLimit ===
            PLANES.Standard.bondLimit
    );

    const p2 = await crear('Premium');
    chequear(
        're-acreditar el MISMO plan SÍ aplica (el camino `already` sigue curando)',
        await aplicar(p2, 'Premium')
    );

    // Documento con el campo AUSENTE, insertado por el driver.
    const col = mongoose.connection.collection('normalusers');
    const idSin = oid();
    await col.insertOne({
        _id: idSin as any,
        user: oid(),
        name: 'legado',
        // email único: la colección tiene un índice unique y dos `null` chocan.
        email: `${idSin}@x.com`,
    } as any);
    chequear(
        'un documento SIN subscriptionType puede recibir su plan pago',
        await aplicar(idSin, 'Premium')
    );

    // Valor DESCONOCIDO (enum viejo): es lo que el `$nin` vino a cubrir.
    const idRaro = oid();
    await col.insertOne({
        _id: idRaro as any,
        user: oid(),
        name: 'raro',
        email: `${idRaro}@x.com`,
        subscriptionType: 'Basic',
    } as any);
    chequear(
        'un subscriptionType DESCONOCIDO puede recibir su plan (lo que el $nin arregló)',
        await aplicar(idRaro, 'Premium')
    );

    chequear(
        'tiposHastaNivelDe coincide con lo que el filtro deja pasar',
        tiposHastaNivelDe('Standard').length === 2
    );
};

// ── 5. El historial de la palanca: $push + $slice junto con $set ────────────
const grupoHistorial = async () => {
    console.log('\n── El historial de la palanca ($push + $slice con $set)');
    await NormalUser.deleteMany({});
    const u = await NormalUser.create({
        user: oid(),
        name: 'x',
        email: `${oid()}@x.com`,
        subscriptionType: 'Premium',
    } as any);

    const admin = oid();
    const escribir = async (tipo: TipoPlan, motivo: string, from: string) =>
        NormalUser.updateOne(
            { _id: u._id },
            {
                $set: {
                    subscriptionType: tipo,
                    bondLimit: PLANES[tipo].bondLimit,
                    subscriptionSetBy: admin,
                    subscriptionSetAt: new Date(),
                    subscriptionSetReason: motivo,
                },
                $push: {
                    subscriptionHistory: {
                        $each: [
                            { type: tipo, by: admin, at: new Date(), reason: motivo, from },
                        ],
                        $slice: -50,
                    },
                },
            } as any
        );

    await escribir('Free', 'contracargo del pago X', 'Premium');
    await escribir('Premium', 'el usuario reclamó', 'Free');

    const doc = await NormalUser.findById(u._id).lean<any>();
    chequear(
        '`$push` + `$slice` conviven con `$set` en el mismo update',
        Array.isArray(doc.subscriptionHistory) &&
            doc.subscriptionHistory.length === 2
    );
    chequear(
        'el registro del CONTRACARGO sobrevive al cambio posterior (era un casillero que se pisaba)',
        doc.subscriptionHistory[0]?.reason === 'contracargo del pago X' &&
            doc.subscriptionHistory[0]?.from === 'Premium'
    );
    chequear(
        'el denormalizado refleja el ÚLTIMO cambio',
        doc.subscriptionSetReason === 'el usuario reclamó' &&
            doc.subscriptionType === 'Premium'
    );
};

// ── 6. La idempotencia del cobro: el índice único de transactionId ──────────
const grupoTransaccion = async () => {
    console.log('\n── El candado de idempotencia del cobro');
    await Transaction.deleteMany({});
    await Transaction.syncIndexes();

    const tx = { user: oid(), type: 'Subscription', amount: 25, transactionId: 'CAP-1' };
    await Transaction.create(tx as any);

    let codigo = 0;
    try {
        await Transaction.create(tx as any);
    } catch (e: any) {
        codigo = e?.code;
    }
    chequear(
        'el mismo transactionId choca con 11000 (es el candado de todo el flujo)',
        codigo === 11000,
        `código ${codigo}`
    );

    const creada = await Transaction.findOne({ transactionId: 'CAP-1' }).lean<any>();
    chequear('nace con `applied: false`', creada?.applied === false);

    await Transaction.updateOne(
        { transactionId: 'CAP-1' },
        { $set: { applied: true } }
    );
    const marcada = await Transaction.findOne({
        transactionId: 'CAP-1',
    }).lean<any>();
    chequear(
        'se puede marcar aplicada (lo que impide que `already` revierta la palanca)',
        marcada?.applied === true
    );

    const sinAplicar = await Transaction.countDocuments({
        type: 'Subscription',
        applied: false,
    });
    chequear(
        'la consulta "quién pagó y no recibió" funciona',
        sinAplicar === 0,
        `devolvió ${sinAplicar}`
    );
};

const main = async () => {
    const externa = process.env.VERIFY_MONGO_URL;
    let memoria: any = null;
    let url = externa;

    if (!url) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { MongoMemoryReplSet } = require('mongodb-memory-server');
        // REPLICA SET y no standalone: `computeAndCacheMatches` y la creación de
        // vínculos usan transacciones, que Mongo sólo soporta con replica set.
        console.log('Levantando un Mongo efímero (replica set)…');
        //  generoso: el default de 10 s no alcanza para un arranque
        // en frío (la primera vez el binario se descarga, y en Windows el arranque
        // es lento). Sin esto la verificación falla por la razón equivocada.
        memoria = await MongoMemoryReplSet.create({
            replSet: { count: 1 },
            instanceOpts: [{ launchTimeout: 120_000 }],
        });
        url = memoria.getUri();
    } else {
        // ⚠️ GUARDA DE BORRADO. Esta verificación hace CINCO `deleteMany({})` sobre
        // `bondrequests`, `normalusers` y `transactions`: vacía la base a la que
        // apunte. (Hay un sexto, pero es sobre `probaAusentes`, una colección de
        // juguete que el propio script dropea después.) Con el Mongo efímero eso es inofensivo, pero cuando
        // `mongodb-memory-server` no está instalado el script fallaba sugiriendo
        // justamente `VERIFY_MONGO_URL=…`, y en el servidor el único Mongo que el
        // operador tiene a mano es PRODUCCIÓN. `DEPLOY-metodo.md` manda correr
        // esto en el servidor: el camino al desastre estaba señalizado.
        //
        // Dos candados, y hacen falta los dos:
        //   1. el nombre de la base tiene que declararse descartable, y
        //   2. una variable de confirmación explícita, que nadie tipea por inercia.
        // EL NOMBRE DE LA BASE, DERIVADO EN EL ORDEN QUE LO HACE CORRECTO.
        //
        // Este parseo se rompió dos veces y cada versión rompió algo distinto, así
        // que va escrito el porqué de CADA paso:
        //
        //   1. sacar el esquema PRIMERO. Sin esto, una URI sin credenciales no
        //      tiene `@`, y `split('@').pop()` devuelve la cadena ENTERA —con el
        //      `mongodb://` adelante—, así que el `[1]` cae en la cadena vacía de
        //      entre las dos barras y el nombre sale VACÍO. Medido: las cuatro
        //      formas sin credenciales quedaban rechazadas, incluido el comando
        //      de ejemplo que este mismo archivo imprime.
        //   2. cortar por `?` ANTES del `@`: un parámetro de query puede traer `@`.
        //   3. tomar el ÚLTIMO `@`: la contraseña puede traer `@` y hasta `/`.
        //   4. recién ahí partir por `/`.
        //
        // Y la primera versión de todas hacía `url.split('?')[0].split('/').pop()`,
        // que con el estilo de Atlas (sin barra antes del `?`) devolvía la
        // AUTORIDAD y la interpolaba en los mensajes: **imprimía usuario y
        // contraseña del cluster en el log del deploy**. La guarda contra borrar
        // producción filtraba las credenciales de producción. Por eso, en los
        // mensajes de estas guardas no se interpola nunca la URI cruda.
        const sinEsquema = url.replace(/^mongodb(\+srv)?:\/\//, '');
        const nombreBase = (
            (sinEsquema.split('?')[0].split('@').pop() || '').split('/')[1] || ''
        ).toLowerCase();

        // `test` NO está en la lista, y es deliberado: es la base POR DEFECTO del
        // driver, y con el estilo de URI de este repo (las de ejemplo no traen
        // nombre de base) es exactamente donde viven los usuarios, los vínculos y
        // las transacciones reales. Bendecirla convertía la guarda en un adorno.
        const declaradaDescartable =
            /(prueba|verify|efimer|scratch|descartable)/.test(nombreBase);

        if (!nombreBase) {
            console.error(
                '\n⛔ VERIFY_MONGO_URL no nombra ninguna base.\n\n' +
                    'Sin nombre, el driver usa "test", que con las URI de este repo es\n' +
                    'donde están los datos reales. Esta verificación BORRA usuarios,\n' +
                    'vínculos y transacciones: poné un nombre explícito y descartable.\n\n' +
                    '  VERIFY_MONGO_URL=mongodb://host/bankybondy-verify-descartable \\\n' +
                    '  VERIFY_MONGO_BORRAR=si-esta-base-es-descartable\n'
            );
            process.exit(1);
        }
        if (!declaradaDescartable) {
            console.error(
                `\n⛔ VERIFY_MONGO_URL apunta a la base "${nombreBase}".\n\n` +
                    'Esta verificación BORRA usuarios, vínculos y transacciones de la base a\n' +
                    'la que apunte. Para que no BORRE producción por accidente, el\n' +
                    'nombre de la base tiene que decir que es descartable: incluir "prueba",\n' +
                    '"verify", "efimero", "scratch" o "descartable".\n\n' +
                    'Si querés correrla, apuntá a una base de descarte:\n' +
                    '  VERIFY_MONGO_URL=mongodb://host/bankybondy-verify-descartable \\\n' +
                    '  VERIFY_MONGO_BORRAR=si-esta-base-es-descartable\n'
            );
            process.exit(1);
        }
        if (process.env.VERIFY_MONGO_BORRAR !== 'si-esta-base-es-descartable') {
            console.error(
                `\n⛔ Falta la confirmación para borrar la base "${nombreBase}".\n\n` +
                    'Esta verificación la vacía. Si de verdad es descartable, repetí con:\n' +
                    '  VERIFY_MONGO_BORRAR=si-esta-base-es-descartable\n'
            );
            process.exit(1);
        }
        console.log(
            `Usando el Mongo de VERIFY_MONGO_URL (${url.split('@').pop()}) — ` +
                'base declarada descartable y borrado confirmado.'
        );
    }

    await mongoose.connect(url as string);
    console.log(`Conectado. Versión del server: ${
        (await mongoose.connection.db!.admin().serverStatus()).version
    }`);

    try {
        await grupoSemanticaDeAusentes();
        await grupoSweep();
        await grupoBackfill();
        await grupoAntiDowngrade();
        await grupoHistorial();
        await grupoTransaccion();
    } finally {
        await mongoose.disconnect();
        if (memoria) await memoria.stop();
    }

    console.log(`\nTOTAL: ${pass} pasaron, ${fail} fallaron`);
    if (fail) {
        console.error('\n═══ VERIFICACIÓN CONTRA MONGO: 🔴 ROJA ═══');
        process.exit(1);
    }
    console.log('\n═══ VERIFICACIÓN CONTRA MONGO: 🟢 VERDE ═══');
    process.exit(0);
};

main().catch((e: any) => {
    if (e?.code === 'MODULE_NOT_FOUND' && /mongodb-memory-server/.test(e?.message)) {
        console.error(
            '\nFalta `mongodb-memory-server`, que levanta un Mongo efímero para esta\n' +
                'verificación. Dos formas de correrla:\n\n' +
                '  1. Instalarlo SIN tocar package.json (no viaja al deploy):\n' +
                '       npm i --no-save mongodb-memory-server\n\n' +
                '  2. O apuntar a un Mongo que ya exista (staging o el entorno de\n' +
                '     carga; NUNCA producción, porque esto BORRA colecciones):\n' +
                '       VERIFY_MONGO_URL=mongodb://host/bankybondy-verify-descartable VERIFY_MONGO_BORRAR=si-esta-base-es-descartable node dist/scripts/verificarContraMongo.js\n'
        );
        process.exit(1);
    }
    // LA ÚLTIMA FUGA DE CREDENCIALES, y es la que ninguna guarda tapa: si el
    // driver rechaza la URI, el `MongoParseError` la trae ENTERA adentro del
    // mensaje, y este catch-all la imprimía en el log del deploy. Se comprobó con
    // una URI que pasa las tres guardas y aun así hace explotar al driver. Se
    // enmascara todo lo que haya entre `//` y `@`.
    //
    // LA CLASE ES `[^/\s]`, NO `[^@\s]`, y la diferencia es un carácter con dos
    // consecuencias opuestas, las dos reproducidas contra el parser instalado:
    //   · con `[^@\s]`, una contraseña que contenga `@` —permitido si va
    //     codificado, y el driver igual explota— deja la parte posterior al
    //     primer `@` SIN enmascarar: la contraseña terminaba en el log del deploy.
    //   · y al revés, SOBRE-enmascaraba: una URI sin credenciales con un `@` en un
    //     parámetro de query salía como `mongodb://***@b`, o sea que destruía el
    //     diagnóstico que este catch-all existe para dar.
    // Parar en `/` arregla las dos: la autoridad termina ahí.
    const limpio = String(e?.stack || e?.message || e).replace(
        /\/\/[^/\s]*@/g,
        '//***@'
    );
    console.error('La verificación no pudo correr:', limpio);
    process.exit(1);
});
