/* eslint-disable @typescript-eslint/no-explicit-any */
/* Bond matching compute (pairs + cycles) -> ranked deals by the real finalScore, reused by
 * compute-on-miss and the robot (step 5). No bondRequest.service import (circular deps).
 */
import mongoose from 'mongoose';
import NormalUser from '../normalUser/normalUser.model';
import BondMatch from '../bondMatch/bondMatch.model';
// Model only (not the service) to seal `matchesComputedAt`: no circular dependency.
import BondRequest from './bondRequest.model';
import { BondMatchType, IMatchScoreParts } from '../bondMatch/bondMatch.interface';
import { ENUM_BOND_REQUEST_STATUS } from './bondRequest.enum';
import { fetchMatchCandidates } from './matching.candidates';
import { MATCHING } from './matching.config';
import { getMatchingSettings } from '../settings/matchingSettings.service';
import type { MatchingSettingsSnapshot } from '../settings/matchingSettings.interface';
import { persistMatchFeed } from './matching.feed';
import {
    bondMatchFeedTrimDeletedTotal,
    bondMatchFeedUpsertsTotal,
    bondMatchFeedWriteErrorsTotal,
} from '../../middlewares/metrics';
import { logger } from '../../shared/logger';
import { proximoRecomputoEn } from './matching.schedule';
import {
    emptyEdgeScore,
    finalMatchScore,
    freshnessFactor,
    modalityFactor,
    passesGate,
    proximityFactor,
    semanticQuality,
    surpriseAdjustedScore,
} from './matching.scoring';

export interface MatchRecord {
    ids: string[];
    users: string[];
    score: number;
    parts: IMatchScoreParts;
    type: BondMatchType;
    size: number;
}

// ---- semantic helpers (self-contained) ----

// OpenAI embeddings (`text-embedding-3-small`) are L2-normalized, so dot == cosine. We
// pre-normalize once to Float32Array and the hot loop only does a dot product; numerically
// identical to the previous cos, preserving scale, `minScore` and the quality gates.

/** L2-normalizes a raw vector to Float32Array once. null if empty. */
const normalizeToF32 = (v: unknown): Float32Array | null => {
    if (!Array.isArray(v) || v.length === 0) return null;
    const f = new Float32Array(v.length);
    let mag = 0;
    for (let i = 0; i < v.length; i++) {
        const x = typeof v[i] === 'number' ? (v[i] as number) : 0;
        f[i] = x;
        mag += x * x;
    }
    mag = Math.sqrt(mag);
    if (mag > 0) {
        const inv = 1 / mag;
        for (let i = 0; i < f.length; i++) f[i] *= inv;
    }
    return f;
};

/** Dot product over already-normalized vectors == cosine. No sqrt per call. */
const dot = (a: Float32Array, b: Float32Array): number => {
    const n = Math.min(a.length, b.length);
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
};

const normalizeText = (s?: string) =>
    (s || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

/** Chain quality from its edges: same yardstick as pairs (`semanticQuality`),
 *  `wMin·worst + (1-wMin)·mean`, so a cycle is not crushed by its weakest link. Values are
 *  already in [0,1], so is the blend. */
const blendEdges = (edges: number[], wMin: number): number => {
    if (!edges.length) return 0;
    const min = Math.min(...edges);
    const mean = edges.reduce((a, b) => a + b, 0) / edges.length;
    return wMin * min + (1 - wMin) * mean;
};

const finalWeightsOf = (settings: Readonly<MatchingSettingsSnapshot>) => ({
    sem: settings.weightSem,
    rep: settings.weightRep,
    prox: settings.weightProx,
    fresh: settings.weightFresh,
});

/**
 * Directional edge (A's want met by B's offer) over pre-normalized vectors: dot == cosine.
 * "surprise" applies symmetrically (want OR offer); "empty" takes priority, band-only.
 */
const directionalScoreF32 = (
    want: string,
    wantF32: Float32Array | null,
    offer: string,
    offerF32: Float32Array | null,
    settings: Readonly<MatchingSettingsSnapshot>
): number => {
    const wantEmpty = normalizeText(want) === 'empty';
    const offerEmpty = normalizeText(offer) === 'empty';
    const wantSurprise = normalizeText(want) === 'surprise';
    const offerSurprise = normalizeText(offer) === 'surprise';
    // 'empty' has semantic priority: its vector carries no signal (spurious cosine), so it is
    // resolved by band only: empty↔empty = encounter (high), empty↔surprise = mixed (weak),
    // empty↔concrete = 0 (excluded).
    if (wantEmpty || offerEmpty) {
        return emptyEdgeScore(
            wantEmpty,
            wantSurprise,
            offerEmpty,
            offerSurprise,
            settings.emptyEncounter,
            settings.emptyMixed
        );
    }
    // Without empty, the offer needs a real vector. 'surprise' does have one.
    if (!offerF32 || offerF32.length === 0) return 0;
    const sim = wantF32 && wantF32.length ? dot(wantF32, offerF32) : 0;
    return surpriseAdjustedScore(sim, wantSurprise, offerSurprise, settings.surpriseFloor, settings.surpriseMargin);
};

/** Haversine distance in km between two [lng, lat] points. */
const haversineKm = (a?: number[], b?: number[]): number | undefined => {
    if (!a || !b || a.length < 2 || b.length < 2) return undefined;
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLng = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

type MatchType = BondMatchType;

const getPairMatchType = (candidate: any): MatchType => {
    const want = normalizeText(candidate.want);
    const offer = normalizeText(candidate.offer);
    if (want === 'empty' || offer === 'empty') return 'empty';
    if (want === 'surprise' || offer === 'surprise') return 'surprise';
    return 'entry';
};

// ---- main compute ----

/** Computes all possible deals (pairs + cycles of 3–N) for a starting bond. */
export const computeMatchesForBond = async (
    startRequest: any,
    userId: string,
    settings: Readonly<MatchingSettingsSnapshot>
): Promise<MatchRecord[]> => {
    const bondRequestId = startRequest._id.toString();
    const startUser = (startRequest.user?._id || startRequest.user)?.toString();
    const startModality = startRequest.modality;
    const isOnline = startRequest.modality === 'online';

    // Geo as SCORE, not filter (default): no candidate is dropped by distance; proximity still
    // weighs in via proximityFactor, so missing coords never means "0 matches by location".
    // Re-enable a real radius with MATCH_GEO_HARD_FILTER=true.
    const geoFilter: any = {};
    const geoHardFilter =
        (process.env.MATCH_GEO_HARD_FILTER ?? 'false').toLowerCase() === 'true';
    if (
        geoHardFilter &&
        !isOnline &&
        startRequest.location?.coordinates?.length >= 2 &&
        startRequest.radius
    ) {
        const [lng, lat] = startRequest.location.coordinates;
        geoFilter.location = {
            $geoWithin: {
                $centerSphere: [[lng, lat], startRequest.radius / 6371],
            },
        };
    }

    const { candidates } = await fetchMatchCandidates(
        startRequest,
        bondRequestId,
        userId,
        geoFilter,
        settings
    );

    // Single pre-normalization of the 1536-dim vectors; from here the O(N²) hot loop is
    // dot-only. Cached on the object (_offerF32 / _wantF32) so pairs and graph edges reuse it.
    startRequest._offerF32 = normalizeToF32(startRequest.offerVector);
    startRequest._wantF32 = normalizeToF32(startRequest.wantVector);
    for (const c of candidates) {
        c._offerF32 = normalizeToF32(c.offerVector);
        c._wantF32 = normalizeToF32(c.wantVector);
    }

    // Reputation map (cached score on NormalUser, prior if missing).
    const userIds = Array.from(
        new Set(
            candidates
                .map((c) => (c.user?._id || c.user)?.toString())
                .filter(Boolean)
        )
    );
    const repDocs = userIds.length
        ? await NormalUser.find({ _id: { $in: userIds } })
              .select('reputation')
              .lean()
        : [];
    const repByUser = new Map<string, number>();
    for (const u of repDocs as any[]) {
        repByUser.set(
            u._id.toString(),
            typeof u.reputation?.score === 'number'
                ? u.reputation.score
                : MATCHING.reputation.prior
        );
    }
    const repOf = (uid?: string): number => {
        if (!uid) return MATCHING.reputation.prior;
        const v = repByUser.get(uid);
        return typeof v === 'number' ? v : MATCHING.reputation.prior;
    };

    // Per-bond properties (proximity to start; freshness). Online: proximity does not apply
    // (global exchange) -> factor 1.
    const startCoords = startRequest.location?.coordinates;
    const radiusKm: number | undefined = startRequest.radius;
    const proxOfNode = (node: any): number =>
        isOnline
            ? 1
            : proximityFactor(
                  haversineKm(startCoords, node.location?.coordinates),
                  radiusKm
              );
    const freshOfNode = (node: any): number => freshnessFactor(node.updatedAt);

    const records: MatchRecord[] = [];
    const globalSeen = new Set<string>();

    // ---- Pairs (2 people) ----
    for (const candidate of candidates) {
        // No special 'empty' gate: the score defines validity. Invalid combos (concrete want <-
        // empty offer and its mirror) yield edge 0 via `emptyEdgeScore`, filtered by
        // `passesGate`, so gifting is symmetric by construction (it was one-sided before).
        const s1 = directionalScoreF32(
            startRequest.want,
            startRequest._wantF32,
            candidate.offer,
            candidate._offerF32,
            settings
        );
        const s2 = directionalScoreF32(
            candidate.want,
            candidate._wantF32,
            startRequest.offer,
            startRequest._offerF32,
            settings
        );

        if (!passesGate(s1, s2, settings.minScore)) continue;

        const candId = candidate._id.toString();
        const candUser = (candidate.user?._id || candidate.user)?.toString();
        const key = [bondRequestId, candId].sort().join('-');
        if (globalSeen.has(key)) continue;
        globalSeen.add(key);

        const parts: IMatchScoreParts = {
            sem: semanticQuality(s1, s2, settings.wMin),
            rep: repOf(candUser),
            prox: proxOfNode(candidate),
            fresh: freshOfNode(candidate),
        };
        // Modality as soft preference: differing formats lower the score (never exclude);
        // missing modality is tolerated (factor 1).
        const score =
            finalMatchScore(
                {
                    semQuality: parts.sem,
                    reputation: parts.rep,
                    proximity: parts.prox,
                    freshness: parts.fresh,
                },
                finalWeightsOf(settings)
            ) * modalityFactor(startModality, candidate.modality);

        records.push({
            ids: [bondRequestId, candId],
            users: [startUser, candUser].filter(Boolean),
            score,
            parts,
            type: getPairMatchType(candidate),
            size: 2,
        });
    }

    // ---- Graph for cycles ----
    const requestMap = new Map<string, any>(
        candidates.map((c) => [c._id.toString(), c])
    );
    requestMap.set(bondRequestId, startRequest);

    const edges = new Map<string, { to: string; score: number }[]>();
    for (const [id, req] of requestMap.entries()) {
        edges.set(id, []);
        for (const [toId, toReq] of requestMap.entries()) {
            if (id === toId) continue;
            const score = directionalScoreF32(
                req.want,
                req._wantF32,
                toReq.offer,
                toReq._offerF32,
                settings
            );
            if (score >= settings.minScore) {
                edges.get(id)!.push({ to: toId, score });
            }
        }
    }
    // Beam: sort each node's edges by score desc so extension tries the strongest first.
    for (const list of edges.values()) list.sort((a, b) => b.score - a.score);

    const userOfBond = (id: string): string | undefined => {
        const r = requestMap.get(id);
        return (r?.user?._id || r?.user)?.toString();
    };

    const getCycleMatchType = (path: string[]): MatchType => {
        let hasSurprise = false;
        for (const id of path) {
            if (id === bondRequestId) continue;
            const req = requestMap.get(id);
            const want = normalizeText(req?.want);
            const offer = normalizeText(req?.offer);
            if (want === 'empty' || offer === 'empty') return 'empty';
            if (want === 'surprise' || offer === 'surprise') hasSurprise = true;
        }
        return hasSurprise ? 'surprise' : 'entry';
    };

    const seenCycles = new Set<string>();
    const maxCycleSize = MATCHING.maxCycleSize;
    const beamK = MATCHING.cycleBeamK;
    const cycleBudget = MATCHING.cycleBudget;
    let emitted = 0;

    const dfs = (
        startId: string,
        currentId: string,
        path: string[],
        edgeScores: number[]
    ) => {
        if (emitted >= cycleBudget) return;
        if (path.length > maxCycleSize) return;

        const usersInPath = new Set(path.map(userOfBond));
        const neighbors = edges.get(currentId) || [];

        // Cycle closing is evaluated over ALL edges (the beam does NOT limit it), so valid
        // cycles closing on a weaker edge are not lost.
        if (path.length >= 3) {
            const closing = neighbors.find((e) => e.to === startId);
            if (closing) {
                const hash = path.join('-');
                if (!seenCycles.has(hash) && !globalSeen.has(hash)) {
                    seenCycles.add(hash);
                    globalSeen.add(hash);

                    // Cycle quality: same blend as pairs (not crushed by one weak link;
                    // `legacyRanking` reverts to bare min). allEdges includes the closing edge.
                    const allEdges = [...edgeScores, closing.score];
                    const sem = MATCHING.legacyRanking
                        ? Math.min(...allEdges)
                        : blendEdges(allEdges, settings.wMin);

                    // Cycle participants, excluding my own starting bond.
                    const participants = path.filter(
                        (id) => id !== bondRequestId
                    );
                    const reps = participants.map((id) => repOf(userOfBond(id)));
                    const proxs = participants.map((id) =>
                        proxOfNode(requestMap.get(id))
                    );
                    const freshs = participants.map((id) =>
                        freshOfNode(requestMap.get(id))
                    );

                    const parts: IMatchScoreParts = {
                        sem,
                        rep: reps.length ? Math.min(...reps) : MATCHING.reputation.prior,
                        prox: proxs.length ? Math.min(...proxs) : 1,
                        fresh: freshs.length ? Math.min(...freshs) : 1,
                    };
                    // Cycle modality penalty = worst link: min factor between start and participants.
                    const modFactor = participants.length
                        ? Math.min(
                              ...participants.map((id) =>
                                  modalityFactor(
                                      startModality,
                                      requestMap.get(id)?.modality
                                  )
                              )
                          )
                        : 1;
                    const finalScore =
                        finalMatchScore(
                            {
                                semQuality: parts.sem,
                                reputation: parts.rep,
                                proximity: parts.prox,
                                freshness: parts.fresh,
                            },
                            finalWeightsOf(settings)
                        ) * modFactor;

                    records.push({
                        ids: [...path],
                        users: path.map(userOfBond).filter(Boolean) as string[],
                        score: finalScore,
                        parts,
                        type: getCycleMatchType(path),
                        size: path.length,
                    });
                    emitted++;
                }
            }
        }

        // Extension: only the top-K strongest edges (beam); skip repeated bond or user.
        let explored = 0;
        for (const { to, score } of neighbors) {
            if (explored >= beamK || emitted >= cycleBudget) break;
            if (to === startId) continue;
            if (path.includes(to)) continue;
            if (usersInPath.has(userOfBond(to))) continue;
            explored++;
            dfs(startId, to, [...path, to], [...edgeScores, score]);
        }
    };

    dfs(bondRequestId, bondRequestId, [bondRequestId], []);

    // Dedup by bond SET (not DFS path order): A-B-C and A-C-B (or any rotation) are the same
    // group of people -> keep only the highest score. The DFS path hash does not canonicalize
    // direction/rotation. (Pairs were already deduped by `globalSeen`.)
    const bestBySet = new Map<string, MatchRecord>();
    for (const r of records) {
        const key = [...r.ids].sort().join('|');
        const prev = bestBySet.get(key);
        if (!prev || r.score > prev.score) bestBySet.set(key, r);
    }
    const deduped = [...bestBySet.values()];

    // Hard cap: keep only the N BEST by finalScore ("the 100 best"), never more per bond.
    deduped.sort((a, b) => b.score - a.score);
    const top = deduped.slice(0, settings.maxResults);

    // Storage order (serving re-sorts anyway). NEW: pure score (top-N already chosen by
    // quality). LEGACY: pairs before cycles.
    top.sort((a, b) => {
        if (MATCHING.legacyRanking && a.size !== b.size) return a.size - b.size;
        return b.score - a.score;
    });

    return top;
};

/** Replaces the precomputed deals in BondMatch for a starting bond. */
export const persistMatches = async (
    sourceBondId: string,
    records: MatchRecord[],
    computeRevision: number
): Promise<void> => {
    const sourceBond = new mongoose.Types.ObjectId(sourceBondId);
    const docs = records.map((r) => ({
        sourceBond,
        bonds: r.ids.map((id) => new mongoose.Types.ObjectId(id)),
        users: r.users.map((id) => new mongoose.Types.ObjectId(id)),
        score: r.score,
        parts: r.parts,
        type: r.type,
        size: r.size,
        computedAt: new Date(),
        computeRevision,
    }));
    // A delayed job may coexist with newer rows, but must never delete them.
    const filter = { sourceBond, $or: [
        { computeRevision: { $lte: computeRevision } }, { computeRevision: null },
    ] };
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await BondMatch.deleteMany(filter, { session });
            if (docs.length) await BondMatch.insertMany(docs, { session });
        });
    } catch (error) {
        const failure = error as { code?: number; message?: string };
        if (failure.code !== 20 || !failure.message?.includes('Transaction numbers are only allowed')) throw error;
        await BondMatch.deleteMany(filter);
        if (docs.length) await BondMatch.insertMany(docs);
    } finally {
        await session.endSession();
    }
};

/** Computes and caches (invoked by the robot; no longer run per request). */
export const computeAndCacheMatches = async (
    startRequest: any,
    userId: string
): Promise<MatchRecord[]> => {
    const settings = await getMatchingSettings();
    const records = await computeMatchesForBond(startRequest, userId, settings);
    await persistMatches(startRequest._id.toString(), records, settings.computeRevision);

    // Per-participant read model (expand/contract). Best-effort during rollout: a failure falls
    // back to BondMatch and gets logged. When the feed is the read source it PROPAGATES: stale
    // rows must not be sealed, so the job retries.
    if (MATCHING.feedWrite) {
        try {
            const stats = await persistMatchFeed(
                startRequest._id.toString(),
                records,
                settings.computeRevision
            );
            bondMatchFeedUpsertsTotal.inc(stats.upserts);
            bondMatchFeedTrimDeletedTotal.inc(stats.trimmed);
        } catch (e) {
            bondMatchFeedWriteErrorsTotal.inc();
            logger.error(
                `[matching] persistMatchFeed fallo para ${startRequest._id}:`,
                (e as Error)?.message
            );
            if (MATCHING.feedRead) throw e;
        }
    }

    const ahora = Date.now();

    // Adaptive TTL: seal WHEN it computed and schedule WHEN it is next due from the link's
    // temperature (see matching.schedule.ts). `createdAt` falls back to the Mongo `_id`
    // timestamp, else a missing select would make every link cold (24 h) and rot the cache.
    const creadoEn =
        (startRequest as any)?.createdAt ??
        (typeof (startRequest as any)?._id?.getTimestamp === 'function'
            ? (startRequest as any)._id.getTimestamp()
            : undefined);

    // Conditional seal by GENERATION: the filter carries `matchesGen` read at START. If the link
    // was invalidated meanwhile, this update no longer matches, nothing is sealed and the sweep
    // retakes it. Old BondMatch rows stay (serving's ghost filter hides dead counterparts).
    const genAlEmpezar = (startRequest as any)?.matchesGen ?? 0;
    // `$in: [0, null]` matters: `{ matchesGen: 0 }` does NOT match a doc where the field is
    // absent; only `null` does, and `$in` covers null AND missing. Without it, pre-field links
    // never seal and the sweep loops on them. Backfill runs in the API, the sweep in the WORKER.
    const filtroGen =
        genAlEmpezar === 0 ? { $in: [0, null] } : genAlEmpezar;
    const sellado = await BondRequest.updateOne(
        { _id: startRequest._id, matchesGen: filtroGen, $or: [
            { matchesComputeRevision: { $lte: settings.computeRevision } },
            { matchesComputeRevision: null },
        ] },
        {
            $set: {
                // Serving reads this to know the compute ran even with zero `records`, so the
                // front stops polling instead of staying "computing" forever.
                matchesComputedAt: new Date(ahora),
                matchesComputeRevision: settings.computeRevision,
                matchesNextAt: proximoRecomputoEn({
                    ahora,
                    createdAt: creadoEn,
                    lastServedAt: (startRequest as any)?.lastServedAt,
                }),
            },
        }
    );
    if (!sellado.matchedCount) {
        // The message does NOT assert the cause. Zero `matchedCount` can be a concurrent
        // invalidation (expected), a deleted document, or a field not where expected; a log
        // that guesses costs hours of diagnosis.
        logger.warn(
            `[matching] el cómputo del vínculo ${startRequest._id} no se selló ` +
                `(gen esperada ${genAlEmpezar}): invalidación concurrente, o el ` +
                `documento cambió/desapareció. El sweep lo retoma.`
        );
    }
    return records;
};

export { ENUM_BOND_REQUEST_STATUS };
