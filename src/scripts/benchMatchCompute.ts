
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { performance } from 'perf_hooks';
import config from '../app/config';
import BondRequest from '../app/modules/bondRequest/bondRequest.model';
import { ENUM_BOND_REQUEST_STATUS } from '../app/modules/bondRequest/bondRequest.enum';
import { computeMatchesForBond } from '../app/modules/bondRequest/matching.compute';
import { fetchMatchCandidates } from '../app/modules/bondRequest/matching.candidates';
import { buildMatchKey } from '../app/modules/bondRequest/matching.feed';

const BONDS = Math.max(1, Number(process.env.BENCH_BONDS) || 20);
const RUNS = Math.max(1, Number(process.env.BENCH_RUNS) || 15);
const MODE = process.env.MATCH_CANDIDATE_MODE || 'vector';
const LABEL =
    (process.env.BENCH_LABEL || '').trim() || (MODE === 'knn' ? 'knn' : 'vector');
const SNAP_TTL_MS = Number(process.env.MATCH_KNN_SNAPSHOT_TTL_MS ?? 3000);

/** Percentil por rango más cercano, sobre una copia (no muta el original). */
const pct = (arr: number[], p: number): number => {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y);
    const idx = Math.min(
        a.length - 1,
        Math.max(0, Math.ceil((p / 100) * a.length) - 1)
    );
    return a[idx];
};

const round = (n: number): number => Math.round(n * 1000) / 1000;

const statsOf = (arr: number[]) => ({
    p50: round(pct(arr, 50)),
    p95: round(pct(arr, 95)),
    max: round(arr.length ? Math.max(...arr) : 0),
});

type BenchRow = { key: string; score: number };

const main = async (): Promise<void> => {
    await mongoose.connect(config.database_url as string, { maxPoolSize: 50 });

    const bonds = await BondRequest.find({
        status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
        isPause: false,
        isLinked: false,
    })
        .sort({ _id: 1 })
        .limit(BONDS)
        .select(
            'offer want offerVector wantVector location radius user modality createdAt lastServedAt matchesGen'
        )
        .lean();

    if (!bonds.length) {
        throw new Error(
            'No hay bondrequests WAITING_FOR_LINK activos para medir.'
        );
    }

    const totalRuns: number[] = [];
    const candidateRuns: number[] = [];
    const out: Record<string, BenchRow[]> = {};
    let matchSum = 0;
    let measured = 0;

    for (const bond of bonds as any[]) {
        const bondId = bond._id.toString();
        const userId = (bond.user?._id || bond.user)?.toString();
        if (!userId) continue;

        // Warm-up (descartado): calienta el snapshot kNN y el JIT.
        await computeMatchesForBond({ ...bond }, userId);

        let records: any[] = [];
        for (let i = 0; i < RUNS; i++) {
            const t0 = performance.now();
            records = await computeMatchesForBond({ ...bond }, userId);
            totalRuns.push(performance.now() - t0);
        }

        out[bondId] = records.map((r) => ({
            key: buildMatchKey(r.ids),
            score: r.score,
        }));
        matchSum += records.length;
        measured++;

        for (let i = 0; i < RUNS; i++) {
            const t0 = performance.now();
            await fetchMatchCandidates({ ...bond }, bondId, userId, {});
            candidateRuns.push(performance.now() - t0);
        }
    }

    const payload = {
        stats: {
            label: LABEL,
            mode: MODE,
            snapshotTtlMs: SNAP_TTL_MS,
            bonds: measured,
            runsPerBond: RUNS,
            total_ms: statsOf(totalRuns),
            candidates_ms: statsOf(candidateRuns),
            avgMatches: measured ? round(matchSum / measured) : 0,
        },
        out,
    };

    const file = path.join(process.cwd(), `bench-${LABEL}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));

    const s = payload.stats;
    // eslint-disable-next-line no-console
    console.log(
        `[bench] ${s.label} (${s.mode}) bonds=${s.bonds} runs=${s.runsPerBond} ` +
            `total p50=${s.total_ms.p50}ms p95=${s.total_ms.p95}ms max=${s.total_ms.max}ms ` +
            `| candidates p50=${s.candidates_ms.p50}ms p95=${s.candidates_ms.p95}ms ` +
            `max=${s.candidates_ms.max}ms | avgMatches=${s.avgMatches}`
    );
    // eslint-disable-next-line no-console
    console.log(`[bench] escrito ${file}`);
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
