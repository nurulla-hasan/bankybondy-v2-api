/* Limpieza única de vínculos ACTIVOS duplicados (mismo user + offer + want).
 *
 * Necesario ANTES de que se construya el nuevo índice único parcial sobre
 * { user, offer, want } (bondRequest.model.ts): si ya existen duplicados
 * activos, la construcción del índice falla (E11000). Este script agrupa los
 * duplicados EXACTOS (mismos bytes, igual que el índice), conserva el MÁS
 * VIEJO de cada grupo y borra el resto. Idempotente: correrlo dos veces no
 * hace nada la segunda vez.
 *
 * Uso (una sola vez, tras compilar): node dist/scripts/dedupeActiveBonds.js
 */
import mongoose from 'mongoose';
import config from '../app/config';
import BondRequest from '../app/modules/bondRequest/bondRequest.model';
import { ENUM_BOND_REQUEST_STATUS } from '../app/modules/bondRequest/bondRequest.enum';

const main = async (): Promise<void> => {
    await mongoose.connect(config.database_url as string);
    // eslint-disable-next-line no-console
    console.log('[dedupe] DB connected');

    // Grupos de bonds activos con (user, offer, want) idénticos y más de uno.
    const groups = await BondRequest.aggregate([
        {
            $match: {
                status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
                isLinked: { $ne: true },
            },
        },
        { $sort: { createdAt: 1 } }, // el más viejo primero → se conserva
        {
            $group: {
                _id: { user: '$user', offer: '$offer', want: '$want' },
                ids: { $push: '$_id' },
                n: { $sum: 1 },
            },
        },
        { $match: { n: { $gt: 1 } } },
    ]);

    // eslint-disable-next-line no-console
    console.log(`[dedupe] grupos duplicados: ${groups.length}`);

    let removed = 0;
    for (const g of groups as Array<{ ids: mongoose.Types.ObjectId[] }>) {
        const [, ...toDelete] = g.ids; // conserva ids[0] (el más viejo)
        if (toDelete.length) {
            const res = await BondRequest.deleteMany({ _id: { $in: toDelete } });
            removed += res.deletedCount || 0;
        }
    }

    // eslint-disable-next-line no-console
    console.log(`[dedupe] done. duplicados borrados=${removed}`);
};

main()
    .then(async () => {
        await mongoose.connection.close();
        process.exit(0);
    })
    .catch(async (err) => {
        // eslint-disable-next-line no-console
        console.error('[dedupe] FALLO:', err);
        await mongoose.connection.close().catch(() => undefined);
        process.exit(1);
    });
