/* Tunable bond matching config.
 * Every weight/threshold can be overridden by env vars. Final weights sum to 1.0 by default. */

import { AGENDA } from './matching.schedule';

const num = (
    v: string | undefined,
    def: number,
    opts?: { min?: number; max?: number }
): number => {
    // A blank env (`MATCH_MIN_SCORE=`) counts as absent: Number('') is 0 (finite) and
    // silently overrode the default, so the gate became 0 and everything matched.
    const raw = typeof v === 'string' ? v.trim() : v;
    const n = raw === '' || raw === undefined ? NaN : Number(raw);
    let out = Number.isFinite(n) ? n : def;
    // Safety clamp: a mistyped env (e.g. MATCH_MAX_CYCLE_SIZE=9999) must not unbound the
    // DFS/candidate set; caps bound the O(N²) worst case (graph, cycle combinatorics).
    if (opts) {
        if (opts.min !== undefined && out < opts.min) out = opts.min;
        if (opts.max !== undefined && out > opts.max) out = opts.max;
    }
    return out;
};

export const MATCHING = {
    // Hard gate: both directions must clear this to even qualify.
    minScore: num(process.env.MATCH_MIN_SCORE, 0.4),

    // Weight of the weakest link (min) vs the average in semantic quality.
    wMin: num(process.env.MATCH_W_MIN, 0.7),

    // Final-score weights (ideally sum to 1).
    weights: {
        sem: num(process.env.MATCH_W_SEM, 0.5),
        rep: num(process.env.MATCH_W_REP, 0.25),
        prox: num(process.env.MATCH_W_PROX, 0.15),
        // Effectively neutralized (deliberate): `freshnessFactor` reads `updatedAt`, which our
        // own resealing overwrites (~1 for everyone). Do NOT set `timestamps: false` when
        // sealing: real freshness (30d half-life) would drop 6-month links below
        // `minServeScore`, and editing a link is forbidden, so nothing could refresh them.
        fresh: num(process.env.MATCH_W_FRESH, 0.1),
    },

    // Bayesian reputation.
    reputation: {
        prior: num(process.env.REP_PRIOR, 0.6), // neutral / cold-start value
        priorWeight: num(process.env.REP_PRIOR_WEIGHT, 5), // pseudo-count
    },

    // Freshness: decay half-life in days.
    freshnessHalfLifeDays: num(process.env.MATCH_FRESHNESS_HALFLIFE_DAYS, 30),

    // Vector search. Defaults keep cold compute cheap: smaller N = cheaper O(N²) edge graph.
    // Scoring quality is unchanged; only retrieval fan-out narrows. Env-overridable.
    vectorIndexName: process.env.MATCH_VECTOR_INDEX || 'bond_vector_index',
    candidateK: num(process.env.MATCH_CANDIDATE_K, 120, { min: 1, max: 500 }),
    numCandidates: num(process.env.MATCH_NUM_CANDIDATES, 500, {
        min: 1,
        max: 2000,
    }),

    // Retry $vectorSearch on TRANSIENT failures before degrading to random $sample, so a
    // momentary blip never leaves a bond randomly matched. 0 = no retry; backoff grows linearly.
    vectorSearchRetries: num(process.env.MATCH_VECTOR_SEARCH_RETRIES, 1, {
        min: 0,
        max: 5,
    }),
    vectorSearchRetryDelayMs: num(
        process.env.MATCH_VECTOR_SEARCH_RETRY_DELAY_MS,
        150,
        { min: 0, max: 2000 }
    ),

    // Frontier expansion: 1 ANN hop per direction covers cycles up to 5. Kept enabled; only
    // seeds/candidates are trimmed to cut cost.
    frontierEnabled:
        (process.env.MATCH_FRONTIER_ENABLED ?? 'true').toLowerCase() !== 'false',
    frontierSeeds: num(process.env.MATCH_FRONTIER_SEEDS, 5, { min: 1, max: 20 }),
    frontierK: num(process.env.MATCH_FRONTIER_K, 10, { min: 1, max: 50 }),
    frontierNumCandidates: num(process.env.MATCH_FRONTIER_NUM_CANDIDATES, 100, {
        min: 1,
        max: 2000,
    }),

    // Soft preference for shorter chains, applied at SERVING as a ranking subtraction: per
    // member beyond 2 discount `pairBias` (size 2 = 0, 3 = -pairBias, ...). Not a dictator.
    // 0 = no preference. Env-tunable without recompute (applied when reading the cache).
    pairBias: num(process.env.MATCH_PAIR_BIAS, 0.05),

    // Safety switch. 'false' (default) = new ranking: by score, cycle uses the same blend as
    // pairs (0.7·min + 0.3·avg), pairBias as soft preference. 'true' = old ranking (hard
    // size→type→score order, cycle by bare min) for an instant revert.
    legacyRanking:
        (process.env.MATCH_LEGACY_RANKING ?? 'false').toLowerCase() === 'true',

    // Cycles.
    maxCycleSize: num(process.env.MATCH_MAX_CYCLE_SIZE, 5, { min: 2, max: 6 }),

    // Hard cap: only the N best by finalScore are stored/served per bond.
    maxResults: num(process.env.MATCH_MAX_RESULTS, 100, { min: 1, max: 500 }),
    // Serving threshold on the FINAL composite score (not the per-edge `minScore` gate).
    // Serving by `bonds` unions chains this bond originated with chains others originated
    // where it participates, so re-cap here: return only the `maxResults` best above this.
    minServeScore: num(process.env.MATCH_MIN_SERVE_SCORE, 0.4, { min: 0, max: 1 }),
    // DFS beam: at each node extend only through the K strongest edges (cycle closing is
    // evaluated separately, unlimited). Bounds combinatorics while keeping top cycles.
    cycleBeamK: num(process.env.MATCH_CYCLE_BEAM_K, 8, { min: 1, max: 20 }),
    // Hard budget of emitted cycles before the DFS cuts off (safety net).
    cycleBudget: num(process.env.MATCH_CYCLE_BUDGET, 4000, {
        min: 1,
        max: 20000,
    }),

    // Cap on invalidation fan-out (matching.robot.ts): max sourceBonds re-enqueued at once on
    // edit/pause/delete; the rest defer to the sweep. Avoids O(N²) recompute avalanches.
    invalidationFanout: num(process.env.MATCH_MAX_INVALIDATION_FANOUT, 200, {
        min: 1,
        max: 2000,
    }),

    // Worker BullMQ `lockDuration` (ms); rationale in matching.robot.ts. Bounded: a negative
    // env made the worker take no jobs, a few seconds stalled normal computes.
    lockDurationMs: num(process.env.MATCH_LOCK_DURATION_MS, 120000, {
        min: 30000,
        max: 600000,
    }),

    // Cache TTL: minutes a live compute stays valid before recompute (the robot keeps it
    // fresh). Answers "refresh?", NOT "may we show it?" (that is serveTtlMinutes).
    cacheTtlMinutes: num(process.env.MATCH_CACHE_TTL_MINUTES, 60),

    // Serve threshold: "is this cache still worth SHOWING?", separate from the refresh TTL.
    // Sharing the number once meant spinner + zero matches on 61-min caches. Its min clamps to
    // the coldest TTL (AGENDA.ttlFrioMin), not the refresh TTL; default 48 h leaves margin.
    serveTtlMinutes: num(process.env.MATCH_SERVE_TTL_MINUTES, 48 * 60, {
        min: Math.max(
            num(process.env.MATCH_CACHE_TTL_MINUTES, 60),
            AGENDA.ttlFrioMin
        ),
        max: 30 * 24 * 60,
    }),

    // Online and in-person MAY match each other with a score penalty (soft, not a filter), so
    // nobody is excluded by modality. 'false' restores the hard same-modality filter.
    crossModality:
        (process.env.MATCH_CROSS_MODALITY ?? 'true').toLowerCase() !== 'false',
    // Multiplier when both formats are explicit and differ; if either is missing (legacy), 1.
    modalityMismatchFactor: num(process.env.MATCH_MODALITY_MISMATCH_FACTOR, 0.85, {
        min: 0,
        max: 1,
    }),

    // "surprise" wildcard, applied symmetrically (want OR offer). Three bands:
    // surprise↔surprise = surpriseFloor (0.45, passes the 0.4 gate, ranks last);
    // surprise↔concrete = floor + margin (0.55, a bonus not a multiplier); concrete↔concrete
    // = real similarity.
    surpriseFloor: num(process.env.MATCH_SURPRISE_FLOOR, 0.45, { min: 0, max: 1 }),
    surpriseMargin: num(process.env.MATCH_SURPRISE_MARGIN, 0.1, { min: 0, max: 1 }),

    // 'empty' wildcard bands: empty↔empty = emptyEncounter (0.9, the date-app perfect
    // encounter); empty↔surprise = emptyMixed (0.55); empty↔concrete = 0 (excluded; the edge
    // stays 0 and `passesGate` drops it). Invariant: minScore (0.4) < emptyMixed < emptyEncounter.
    emptyEncounter: num(process.env.MATCH_EMPTY_ENCOUNTER, 0.9, { min: 0, max: 1 }),
    emptyMixed: num(process.env.MATCH_EMPTY_MIXED, 0.55, { min: 0, max: 1 }),

    // Wildcard bonds have signal-less vectors, so vector search never returns them mid-chain.
    // They are always added via a bounded direct query; purely additive (never removes or
    // re-scores).
    includeWildcards:
        (process.env.MATCH_INCLUDE_WILDCARDS ?? 'true').toLowerCase() !== 'false',
    // Cap on wildcards added per compute (bounds the O(N²) graph).
    wildcardCap: num(process.env.MATCH_WILDCARD_CAP, 100, { min: 1, max: 1000 }),

    // ── PER-PARTICIPANT READ MODEL (BondMatchFeed) ──────────────────────────
    // Serving reads the N best rows of a bond's own feed via { bond: 1, score: -1 } instead of
    // the whole BondMatch superset. Flags support the expand/contract rollout.
    feedWrite:
        (process.env.MATCH_FEED_WRITE ?? 'false').toLowerCase() === 'true',
    feedShadow:
        (process.env.MATCH_FEED_SHADOW ?? 'false').toLowerCase() === 'true',
    feedRead:
        (process.env.MATCH_FEED_READ ?? 'false').toLowerCase() === 'true',
    // Fraction of requests (0–1) running the shadow comparison with the OLD slow query;
    // sampling is mandatory.
    feedShadowSample: num(process.env.MATCH_FEED_SHADOW_SAMPLE, 0.1, {
        min: 0,
        max: 1,
    }),
    // Rows fetched to re-rank in memory; serves up to `maxResults` (100), 4x overscan covers
    // the soft `pairBias` preference.
    feedScanLimit: num(process.env.MATCH_FEED_SCAN_LIMIT, 400, {
        min: 100,
        max: 2000,
    }),
    // Per-participant row cap (post-recompute prune). Must be >= `feedScanLimit`: pruning below
    // what serving can read silently caps matches. Both default 400; guarded by
    // matching.feed.test.ts.
    feedMaxRowsPerBond: num(process.env.MATCH_FEED_MAX_ROWS_PER_BOND, 400, {
        min: 100,
        max: 4000,
    }),
    // Safety TTL: rows no longer refreshed are deleted. Keep >= serveTtlMinutes (48 h) so live
    // feeds are not emptied.
    feedTtlHours: num(process.env.MATCH_FEED_TTL_HOURS, 48, {
        min: 1,
        max: 720,
    }),
};

export default MATCHING;
