/* Backfill del read model por participante (BondMatchFeed) desde BondMatch.
 *
 * Idempotente y reanudable: recorre BondMatch por `_id` en lotes y hace upsert
 * `(bond, matchKey)`. No borra nada de BondMatch; el camino legacy sigue intacto
 * para rollback.
 *
 * Uso: npx tsx src/scripts/backfillMatchFeed.ts
 */
import mongoose from 'mongoose';
import config from '../app/config';
import BondMatch from '../app/modules/bondMatch/bondMatch.model';
import BondMatchFeed from '../app/modules/bondMatch/bondMatchFeed.model';
import {
    buildMatchKey,
    trimFeedBond,
} from '../app/modules/bondRequest/matching.feed';

const BATCH = 500;

const main = async (): Promise<void> => {
    await mongoose.connect(config.database_url as string);
    // eslint-disable-next-line no-console
    console.log('[feed-backfill] DB connected');

    await BondMatchFeed.createIndexes();
    // eslint-disable-next-line no-console
    console.log('[feed-backfill] indexes ensured');

    let lastId: mongoose.Types.ObjectId | null = null;
    let processed = 0;
    let touched = 0;
    const participants = new Set<string>();

    for (;;) {
        const rows = await BondMatch.find(
            lastId ? { _id: { $gt: lastId } } : {}
        )
            .sort({ _id: 1 })
            .limit(BATCH)
            .lean();
        if (!rows.length) break;

        const now = new Date();
        // Dedup dentro del lote: el mismo trato puede venir guardado bajo dos
        // discoverers (a veces con scores históricos distintos). Nos quedamos
        // con el MEJOR, igual que el serving legacy (bestBySet).
        const docs = new Map<string, any>();

        for (const row of rows as any[]) {
            const bonds = (row.bonds || []).map(
                (id: any) => new mongoose.Types.ObjectId(id.toString())
            );
            if (!bonds.length) continue;
            const matchKey = buildMatchKey(bonds);
            const users = (row.users || []).map(
                (id: any) => new mongoose.Types.ObjectId(id.toString())
            );
            const sourceBond = new mongoose.Types.ObjectId(
                row.sourceBond.toString()
            );

            for (const bondId of bonds) {
                participants.add(bondId.toString());
                const key = `${bondId.toString()}|${matchKey}`;
                const prev = docs.get(key);
                if (prev && prev.score >= row.score) continue;
                docs.set(key, {
                    bond: bondId,
                    matchKey,
                    bonds,
                    users,
                    score: row.score,
                    parts: row.parts ?? {
                        sem: 0,
                        rep: 0,
                        prox: 0,
                        fresh: 0,
                    },
                    type: row.type ?? 'entry',
                    size: row.size ?? bonds.length,
                    sourceBond,
                    computedAt: now,
                });
            }
        }

        // Update por pipeline: si otra fila (de un lote anterior) ya escribió
        // este trato con un score mayor, no lo degradamos.
        const ops: any[] = [];
        for (const doc of docs.values()) {
            const mejor = { $gt: [doc.score, { $ifNull: ['$score', -1] }] };
            ops.push({
                updateOne: {
                    filter: { bond: doc.bond, matchKey: doc.matchKey },
                    update: [
                        {
                            $set: {
                                bonds: doc.bonds,
                                users: doc.users,
                                type: doc.type,
                                size: doc.size,
                                sourceBond: doc.sourceBond,
                                computedAt: doc.computedAt,
                                score: {
                                    $cond: [mejor, doc.score, '$score'],
                                },
                                parts: {
                                    $cond: [mejor, doc.parts, '$parts'],
                                },
                            },
                        },
                    ],
                    upsert: true,
                },
            });
        }

        if (ops.length) {
            const res = await BondMatchFeed.bulkWrite(ops, {
                ordered: false,
            });
            touched +=
                (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
        }

        processed += rows.length;
        lastId = (rows[rows.length - 1] as any)._id;
        if (processed % 5000 < BATCH) {
            // eslint-disable-next-line no-console
            console.log(
                `[feed-backfill] legacy=${processed} feedOps=${touched}`
            );
        }
    }

    // Poda final: los feeds recién creados pueden tener más filas que el tope
    // hasta el próximo recompute de cada bond.
    let trimmed = 0;
    for (const id of participants) {
        trimmed += await trimFeedBond(id);
    }

    const feedCount = await BondMatchFeed.countDocuments();
    // eslint-disable-next-line no-console
    console.log(
        `[feed-backfill] done. legacy=${processed} feedDocs=${feedCount} ` +
            `participants=${participants.size} trimmed=${trimmed}`
    );
};

main()
    .then(async () => {
        await mongoose.connection.close();
        process.exit(0);
    })
    .catch(async (err) => {
        // eslint-disable-next-line no-console
        console.error('[feed-backfill] FALLO:', err);
        await mongoose.connection.close().catch(() => undefined);
        process.exit(1);
    });