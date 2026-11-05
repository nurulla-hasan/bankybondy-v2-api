/* eslint-disable no-console */
/**
 * Backfill (una sola vez) de la reputacion cacheada de NormalUser.
 *
 * Recorre todos los usuarios que han recibido al menos un BondRating (ids
 * distintos en el campo `rated`) y recalcula su reputacion con la misma funcion
 * idempotente que usa el runtime. Seguro de re-ejecutar cuantas veces haga
 * falta: `recomputeReputation` siempre deriva el valor de los datos reales.
 *
 * Ejecutar (tras `tsc`):
 *     node dist/scripts/backfillReputation.js
 */
import mongoose from 'mongoose';
import config from '../app/config';
import BondRating from '../app/modules/bondRating/bondRating.model';
import { recomputeReputation } from '../app/modules/bondRating/reputation.util';

async function main() {
    await mongoose.connect(config.database_url as string, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
    });
    console.log('[backfill] DB connected');

    // Ids distintos de usuarios valorados (solo estos necesitan recalculo;
    // el resto conserva el prior neutro por defecto).
    const ratedIds = (await BondRating.distinct('rated')) as mongoose.Types.ObjectId[];
    console.log(`[backfill] users with ratings: ${ratedIds.length}`);

    let done = 0;
    let failed = 0;
    for (const id of ratedIds) {
        try {
            await recomputeReputation(String(id));
            done += 1;
            if (done % 50 === 0 || done === ratedIds.length) {
                console.log(`[backfill] progress ${done}/${ratedIds.length}`);
            }
        } catch (err) {
            failed += 1;
            console.error(`[backfill] failed for user ${String(id)}`, err);
        }
    }

    console.log(`[backfill] done. recomputed=${done} failed=${failed}`);
}

main()
    .then(async () => {
        await mongoose.connection.close();
        process.exit(0);
    })
    .catch(async (err) => {
        console.error('[backfill] fatal error', err);
        try {
            await mongoose.connection.close();
        } catch {
            /* noop */
        }
        process.exit(1);
    });
