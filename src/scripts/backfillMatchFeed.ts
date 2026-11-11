/* Backfill of the per-participant read model (BondMatchFeed) from BondMatch.
 * Idempotent and resumable: walks BondMatch by `_id` in batches and upserts
 * `(bond, matchKey)`, keeping the best score. Never deletes from BondMatch, so the
 * legacy path stays intact for rollback.
 *
 * Usage: npx tsx src/scripts/backfillMatchFeed.ts
 */
import mongoose from 'mongoose';
import config from '../app/config';
import BondMatch from '../app/modules/bondMatch/bondMatch.model';
import BondMatchFeed from '../app/modules/bondMatch/bondMatchFeed.model';
import {
    buildMatchKey,
    feedUpsertUpdate,
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

        // Dedupe within the batch: the same deal may be stored under two
        // discoverers (sometimes with different historical scores). Keep the BEST,
        // like the legacy serving (bestBySet).
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
                const revision = row.computeRevision ?? 0;
                if (prev && (prev.computeRevision > revision ||
                    (prev.computeRevision === revision && prev.score >= row.score))) continue;
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
                    computedAt: row.computedAt,
                    computeRevision: revision,
                });
            }
        }

        // Update via pipeline: if another row (from an earlier batch) already wrote
        // this deal with a higher score, do not downgrade it.
        const ops: any[] = [];
        for (const doc of docs.values()) {
            ops.push({
                updateOne: {
                    filter: { bond: doc.bond, matchKey: doc.matchKey },
                    update: feedUpsertUpdate(doc),
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

    // Final prune: freshly created feeds may exceed the cap until each bond's
    // next recompute.
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