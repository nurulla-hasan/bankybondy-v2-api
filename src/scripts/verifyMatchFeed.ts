/* Verifies the read model against the legacy path on real bonds.
 *
 * Compares the top-100 by score from legacy (BondMatch by bonds) vs feed
 * (BondMatchFeed by bond), reports jaccard and diffs; exits 1 if the feed misses
 * any legacy match.
 *
 * Usage: npx tsx src/scripts/verifyMatchFeed.ts
 */
import mongoose from 'mongoose';
import config from '../app/config';
import BondMatch from '../app/modules/bondMatch/bondMatch.model';
import BondMatchFeed from '../app/modules/bondMatch/bondMatchFeed.model';
import { buildMatchKey } from '../app/modules/bondRequest/matching.feed';
import { MATCHING } from '../app/modules/bondRequest/matching.config';

const SAMPLE = 25;
const TOP = 100;

/** Top-N of what serving ACTUALLY shows: dedup by set (keeping the highest score),
 *  then sort and cut. Raw legacy rows gave a short "legacyTop" due to duplicates. */
const dedupTop = (rows: any[], n: number): string[] => {
    const best = new Map<string, number>();
    for (const r of rows) {
        const key =
            r.matchKey ??
            buildMatchKey(r.bonds ?? []);
        const score = typeof r.score === 'number' ? r.score : -Infinity;
        const prev = best.get(key);
        if (prev === undefined || score > prev) best.set(key, score);
    }
    return [...best.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([key]) => key);
};

const main = async (): Promise<void> => {
    await mongoose.connect(config.database_url as string);
    // eslint-disable-next-line no-console
    console.log('[feed-verify] DB connected');

    // The most referenced bonds are the worst case (today's slow serving), so they
    // are the right sample.
    const hot = (await BondMatch.aggregate([
        { $unwind: '$bonds' },
        { $group: { _id: '$bonds', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: SAMPLE },
    ])) as Array<{ _id: mongoose.Types.ObjectId; n: number }>;

    // eslint-disable-next-line no-console
    console.log(`[feed-verify] muestra: ${hot.length} bonds`);

    let failed = 0;
    let checked = 0;
    for (const h of hot) {
        const bondId = h._id.toString();
        const [legacy, feed] = await Promise.all([
            BondMatch.find({ bonds: bondId })
                .select('bonds score')
                .lean(),
            BondMatchFeed.find({ bond: bondId })
                .sort({ score: -1, _id: 1 })
                .limit(Math.max(MATCHING.feedScanLimit, 1000))
                .select('matchKey bonds score')
                .lean(),
        ]);

        const legacyKeys = new Set(dedupTop(legacy, TOP));
        const feedKeys = new Set(dedupTop(feed, TOP));
        const missing = [...legacyKeys].filter((k) => !feedKeys.has(k));
        const extra = [...feedKeys].filter((k) => !legacyKeys.has(k));
        const union = new Set([...legacyKeys, ...feedKeys]).size;
        const jaccard = union ? (union - missing.length - extra.length) / union : 1;

        checked++;
        if (missing.length) failed++;
        // eslint-disable-next-line no-console
        console.log(
            `[feed-verify] bond=${bondId} legacyRefs=${h.n} ` +
                `legacyTop=${legacyKeys.size} feedTop=${feedKeys.size} ` +
                `jaccard=${jaccard.toFixed(3)} missing=${missing.length} extra=${extra.length}`
        );
    }

    // eslint-disable-next-line no-console
    console.log(
        `[feed-verify] done. bonds=${checked} conFaltantes=${failed}`
    );
    if (failed > 0) {
        throw new Error(
            `${failed}/${checked} bonds tienen matches del legacy ausentes en el feed.`
        );
    }
};

main()
    .then(async () => {
        await mongoose.connection.close();
        process.exit(0);
    })
    .catch(async (err) => {
        // eslint-disable-next-line no-console
        console.error('[feed-verify] FALLO:', err?.message || err);
        await mongoose.connection.close().catch(() => undefined);
        process.exit(1);
    });