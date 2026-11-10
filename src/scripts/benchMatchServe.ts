/* Local benchmark: LEGACY read (superset by bonds) vs FEED (indexed top-N).
 * No API or auth needed; measures read + hydrate + serialize of serving rows.
 * Usage: npx tsx src/scripts/benchMatchServe.ts [--bond=<id>]
 */
import mongoose from 'mongoose';
import { performance } from 'perf_hooks';
import config from '../app/config';
import BondMatch from '../app/modules/bondMatch/bondMatch.model';
import BondMatchFeed from '../app/modules/bondMatch/bondMatchFeed.model';
import { MATCHING } from '../app/modules/bondRequest/matching.config';

const RUNS = 5;

const mb = (rows: unknown) =>
    Buffer.byteLength(JSON.stringify(rows)) / (1024 * 1024);

const measure = async (
    label: string,
    fn: () => Promise<any[]>
): Promise<void> => {
    let best = Infinity;
    let rows: any[] = [];
    for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        rows = await fn();
        const ms = performance.now() - t0;
        if (ms < best) best = ms;
    }
    // eslint-disable-next-line no-console
    console.log(
        `${label.padEnd(28)} docs=${String(rows.length).padStart(6)} ` +
            `best=${best.toFixed(1).padStart(8)} ms  json=${mb(rows).toFixed(2)} MB`
    );
};

const pickHotBond = async (): Promise<string> => {
    const rows = (await BondMatch.aggregate([
        { $unwind: '$bonds' },
        { $group: { _id: '$bonds', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 1 },
    ])) as Array<{ _id: mongoose.Types.ObjectId; n: number }>;
    if (!rows.length) throw new Error('No hay BondMatch para medir.');
    // eslint-disable-next-line no-console
    console.log(
        `[bench] bond más referenciado: ${rows[0]._id} (${rows[0].n} filas legacy)`
    );
    return rows[0]._id.toString();
};

const main = async (): Promise<void> => {
    await mongoose.connect(config.database_url as string);
    // eslint-disable-next-line no-console
    console.log('[bench] DB connected');

    const arg = process.argv.find((a) => a.startsWith('--bond='));
    const bondId = arg ? arg.split('=')[1] : await pickHotBond();

    await measure('LEGACY { bonds: id }', () =>
        BondMatch.find({ bonds: bondId })
            .sort({ size: 1, score: -1, _id: 1 })
            .lean()
    );

    await measure(
        `FEED top-${MATCHING.feedScanLimit}`,
        () =>
            BondMatchFeed.find({ bond: bondId })
                .sort({ score: -1, _id: 1 })
                .limit(MATCHING.feedScanLimit)
                .batchSize(MATCHING.feedScanLimit)
                .lean()
    );

    const feedCount = await BondMatchFeed.countDocuments({ bond: bondId });
    // eslint-disable-next-line no-console
    console.log(`[bench] filas de feed para el bond: ${feedCount}`);
};

main()
    .then(async () => {
        await mongoose.connection.close();
        process.exit(0);
    })
    .catch(async (err) => {
        // eslint-disable-next-line no-console
        console.error('[bench] FALLO:', err?.message || err);
        await mongoose.connection.close().catch(() => undefined);
        process.exit(1);
    });