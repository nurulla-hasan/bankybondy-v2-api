/* One-time cleanup of duplicate ACTIVE links (same user + offer + want). Required
 * BEFORE the new partial unique index on { user, offer, want } can build: existing
 * duplicates make it fail with E11000. Groups exact duplicates (same bytes as the
 * index), keeps the OLDEST and deletes the rest. Idempotent.
 *
 * Usage (once, after compiling): node dist/scripts/dedupeActiveBonds.js
 */
import mongoose from 'mongoose';
import config from '../app/config';
import BondRequest from '../app/modules/bondRequest/bondRequest.model';
import { ENUM_BOND_REQUEST_STATUS } from '../app/modules/bondRequest/bondRequest.enum';

const main = async (): Promise<void> => {
    await mongoose.connect(config.database_url as string);
    // eslint-disable-next-line no-console
    console.log('[dedupe] DB connected');

    // Active bond groups with identical (user, offer, want) and more than one member.
    const groups = await BondRequest.aggregate([
        {
            $match: {
                status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
                isLinked: { $ne: true },
            },
        },
        { $sort: { createdAt: 1 } }, // oldest first → kept
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
        const [, ...toDelete] = g.ids; // keep ids[0] (the oldest)
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
