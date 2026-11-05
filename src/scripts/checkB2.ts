/* Verifica la tanda B2 (Personas) en la base: los tres índices nuevos y el dato
 * `NormalUser.hasActiveBonds` sembrado y al día.
 *
 * Los índices: `autoIndex` de Mongoose los construye al arrancar y SI FALLA LO
 * HACE EN SILENCIO (ver checkUserIndexes.ts). Sin `personas_destacados`,
 * Destacados vuelve a ordenar a todos los usuarios en memoria en cada carga.
 *
 * NO importa modelos, a propósito: importar un modelo dispara su `autoIndex` al
 * conectar, y el script crearía lo mismo que tiene que verificar.
 *
 * Solo LEE. Correrlo recién cuando el log de la API muestre
 * `[vinculosVivos] backfill:` (antes, "sin campo" da distinto de 0 y es normal).
 * Un "falta encender/apagar" de 1 o 2 puede ser una escritura del mismo
 * instante: correrlo de nuevo; si persiste, es un bug.
 *
 * Uso (tras compilar):
 *   node dist/scripts/checkB2.js; echo FIN=$?     (0 = todo bien, 1 = algo falta)
 */
import mongoose from 'mongoose';
import config from '../app/config';
import { ENUM_BOND_REQUEST_STATUS } from '../app/modules/bondRequest/bondRequest.enum';

/* eslint-disable no-console */

// El filtro de normalUser/vinculosVivos.ts (FILTRO_VINCULO_VIVO), copiado para
// no importar ese módulo, que importa los modelos.
const VIVO = {
    status: {
        $in: [
            ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
            ENUM_BOND_REQUEST_STATUS.ONGOING,
        ],
    },
    isPause: false,
    isLinked: { $ne: true },
};

const ESPERADOS: Array<[string, Record<string, 1 | -1>]> = [
    [
        'normalusers',
        { hasActiveBonds: -1, 'reputation.score': -1, updatedAt: -1, _id: 1 },
    ],
    ['bondrequests', { status: 1, isPause: 1, isLinked: 1, user: 1 }],
    ['users', { isBlocked: 1 }],
];

const main = async (): Promise<void> => {
    await mongoose.connect(config.database_url as string);
    const db = mongoose.connection.db;
    if (!db) throw new Error('sin conexión a la base');
    let mal = 0;

    // Por FORMA de la clave y por prefijo, excluyendo parciales/sparse/collation:
    // el mismo criterio de checkUserIndexes.ts, y por los mismos motivos.
    for (const [col, clave] of ESPERADOS) {
        const idx = await db.collection(col).indexes();
        const claves = Object.entries(clave);
        const hit = idx.find((i) => {
            if (i.partialFilterExpression || i.sparse || i.collation)
                return false;
            const suyas = Object.entries(i.key || {});
            if (suyas.length < claves.length) return false;
            return claves.every(
                ([k, v], n) => suyas[n][0] === k && suyas[n][1] === v
            );
        });
        console.log(
            `[B2] índice ${col} ${JSON.stringify(clave)}: ${
                hit ? `OK (${hit.name})` : 'FALTA'
            }`
        );
        if (!hit) mal++;
    }

    const nu = db.collection('normalusers');
    const duenos = await db.collection('bondrequests').distinct('user', VIVO);
    const sinCampo = await nu.countDocuments({
        hasActiveBonds: { $exists: false },
    });
    const faltaEncender = await nu.countDocuments({
        _id: { $in: duenos },
        hasActiveBonds: { $ne: true },
    });
    const faltaApagar = await nu.countDocuments({
        _id: { $nin: duenos },
        hasActiveBonds: { $ne: false },
    });
    const encendidos = await nu.countDocuments({ hasActiveBonds: true });
    console.log(
        `[B2] normalusers ${await nu.estimatedDocumentCount()} · con vínculos vivos ${encendidos} · dueños ${duenos.length}`
    );
    console.log(
        `[B2] sin campo ${sinCampo} · falta encender ${faltaEncender} · falta apagar ${faltaApagar} (los tres en 0)`
    );
    if (sinCampo || faltaEncender || faltaApagar) mal++;

    console.log(mal ? '[B2] MAL' : '[B2] OK');
    await mongoose.connection.close();
    process.exit(mal ? 1 : 0);
};

main().catch(async (e) => {
    console.error('[B2] ERROR:', (e as Error)?.message);
    await mongoose.connection.close().catch(() => undefined);
    process.exit(1);
});
