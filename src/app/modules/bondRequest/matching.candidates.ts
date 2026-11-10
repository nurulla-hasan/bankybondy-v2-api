
import mongoose from 'mongoose';
import { ENUM_BOND_REQUEST_STATUS } from './bondRequest.enum';
import BondRequest from './bondRequest.model';
import { MATCHING } from './matching.config';
import { knnSearch } from './matching.vectorStore';
import { errorLogger } from '../../shared/logger';

export type CandidateFetchMethod = 'vector' | 'sample';

export interface CandidateFetchResult {
    candidates: any[];
    method: CandidateFetchMethod;
}

const CANDIDATE_PROJECT = {
    $project: {
        _id: 1,
        user: 1,
        offer: 1,
        want: 1,
        offerVector: 1,
        wantVector: 1,
        location: 1,
        updatedAt: 1,
        modality: 1,
        score: { $meta: 'vectorSearchScore' },
    },
};

const hasVector = (v: unknown): v is number[] =>
    Array.isArray(v) && v.length > 0;

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/** ANN query on a vector path with base + optional geo filter. Retries transient
 *  failures, so the caller falls back to $sample only on a real failure. */
const runVectorSearch = async (
    path: 'offerVector' | 'wantVector',
    queryVector: number[],
    limit: number,
    numCandidates: number,
    baseFilter: Record<string, unknown>,
    geoFilter: Record<string, unknown>
): Promise<any[]> => {
    if (process.env.MATCH_CANDIDATE_MODE === 'knn') {
        return knnSearch(path, queryVector, limit, baseFilter, geoFilter);
    }
    const pipeline: any[] = [
        {
            $vectorSearch: {
                index: MATCHING.vectorIndexName,
                path,
                queryVector,
                numCandidates,
                limit,
                filter: baseFilter,
            },
        },
    ];
    if (geoFilter && Object.keys(geoFilter).length) {
        pipeline.push({ $match: geoFilter });
    }
    pipeline.push(CANDIDATE_PROJECT);

    let lastErr: unknown;
    for (let attempt = 0; attempt <= MATCHING.vectorSearchRetries; attempt++) {
        try {
            return await BondRequest.aggregate(pipeline);
        } catch (err) {
            lastErr = err;
            if (attempt < MATCHING.vectorSearchRetries) {
                await sleep(MATCHING.vectorSearchRetryDelayMs * (attempt + 1));
            }
        }
    }
    throw lastErr;
};

// Wildcards carry no vector signal, so they're fetched by a direct bounded query and
// added additively so they can bridge chains. Matchers are case-insensitive on purpose:
// two creation UIs persist 'Empty'/'Surprise' vs 'empty', and a literal $in missed them.
const WILDCARD_TOKEN_MATCHERS = [/^surprise$/i, /^empty$/i];

const WILDCARD_PROJECT = {
    $project: {
        _id: 1,
        user: 1,
        offer: 1,
        want: 1,
        offerVector: 1,
        wantVector: 1,
        location: 1,
        updatedAt: 1,
        modality: 1,
    },
};

/** Active wildcard bonds (offer/want = surprise/empty) with the same base filter + geo,
 *  capped by wildcardCap. */
const fetchWildcardCandidates = async (
    baseFilter: Record<string, unknown>,
    geoFilter: Record<string, unknown>
): Promise<any[]> => {
    if (!MATCHING.includeWildcards) return [];
    const match: Record<string, unknown> = {
        ...baseFilter,
        $or: [
            { offer: { $in: WILDCARD_TOKEN_MATCHERS } },
            { want: { $in: WILDCARD_TOKEN_MATCHERS } },
        ],
        ...geoFilter,
    };
    return BondRequest.aggregate([
        { $match: match },
        { $limit: MATCHING.wildcardCap },
        WILDCARD_PROJECT,
    ]);
};

/**
 * Candidates for the source bond: Atlas Vector Search (bidirectional + frontier),
 * falling back to $sample.
 */
export const fetchMatchCandidates = async (
    startRequest: any,
    bondRequestId: string,
    userId: string,
    geoFilter: Record<string, unknown>
): Promise<CandidateFetchResult> => {
    const startId = bondRequestId.toString();

    // Vector search needs the source bond's vectors.
    const canVector =
        hasVector(startRequest.offerVector) &&
        hasVector(startRequest.wantVector);

    // Modality is a SOFT preference by default: recovery doesn't filter by format (the
    // score penalizes it). MATCH_CROSS_MODALITY=false restores the hard filter.
    const modalityFilter: Record<string, unknown> = MATCHING.crossModality
        ? {}
        : startRequest.modality === 'online'
          ? { modality: 'online' }
          : { modality: { $ne: 'online' } };

    // Shared base filter: active bonds that aren't mine, in the right modality. Used by
    // vector search, $sample and the wildcard query.
    const activeBaseFilter: Record<string, unknown> = {
        status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
        isPause: false,
        isLinked: { $ne: true },
        user: { $ne: new mongoose.Types.ObjectId(userId) },
        ...modalityFilter,
    };

    if (canVector) {
        try {
            // Base filter excludes my own bonds (source included), paused and inactive.
            const baseFilter = activeBaseFilter;

            // Direct neighbors: out (A) and in (B).
            const [outNeighbors, inNeighbors] = await Promise.all([
                runVectorSearch(
                    'offerVector',
                    startRequest.wantVector,
                    MATCHING.candidateK,
                    MATCHING.numCandidates,
                    baseFilter,
                    geoFilter
                ),
                runVectorSearch(
                    'wantVector',
                    startRequest.offerVector,
                    MATCHING.candidateK,
                    MATCHING.numCandidates,
                    baseFilter,
                    geoFilter
                ),
            ]);

            const byId = new Map<string, any>();
            const add = (docs: any[]) => {
                for (const d of docs) {
                    const id = d._id.toString();
                    if (id === startId) continue;
                    if (!byId.has(id)) byId.set(id, d);
                }
            };
            add(outNeighbors);
            add(inNeighbors);

            // Frontier expansion (1 hop, both directions) to reach middle nodes of 4–5 chains.
            if (MATCHING.frontierEnabled) {
                const outSeeds = outNeighbors
                    .filter((d) => hasVector(d.wantVector))
                    .slice(0, MATCHING.frontierSeeds);
                const inSeeds = inNeighbors
                    .filter((d) => hasVector(d.offerVector))
                    .slice(0, MATCHING.frontierSeeds);

                const frontierQueries: Promise<any[]>[] = [];
                // Forward: who OFFERS what my out-neighbor WANTS.
                for (const seed of outSeeds) {
                    frontierQueries.push(
                        runVectorSearch(
                            'offerVector',
                            seed.wantVector,
                            MATCHING.frontierK,
                            MATCHING.frontierNumCandidates,
                            baseFilter,
                            geoFilter
                        )
                    );
                }
                // Backward: who WANTS what my in-neighbor OFFERS.
                for (const seed of inSeeds) {
                    frontierQueries.push(
                        runVectorSearch(
                            'wantVector',
                            seed.offerVector,
                            MATCHING.frontierK,
                            MATCHING.frontierNumCandidates,
                            baseFilter,
                            geoFilter
                        )
                    );
                }

                const frontierResults = await Promise.all(frontierQueries);
                for (const docs of frontierResults) add(docs);
            }

            // Wildcards as chain bridges: always added (additive and bounded).
            add(await fetchWildcardCandidates(activeBaseFilter, geoFilter));

            return { candidates: [...byId.values()], method: 'vector' };
        } catch (err) {
            // HARD ALARM: falling back to $sample means random matching in prod
            // (vector index missing/down). Must look like an error, not a warning.
            errorLogger.error(
                '[matching] ALARMA: vectorSearch caido, degradando a $sample',
                { message: (err as Error)?.message, name: (err as Error)?.name }
            );
        }
    }

    // Fallback: random sample (previous behavior, safe at small scale).
    const candidates = await BondRequest.aggregate([
        {
            $match: {
                _id: { $ne: new mongoose.Types.ObjectId(bondRequestId) },
                user: { $ne: new mongoose.Types.ObjectId(userId) },
                status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
                isPause: false,
                isLinked: { $ne: true },
                ...modalityFilter,
                ...geoFilter,
            },
        },
        { $sample: { size: 150 } },
        {
            $project: {
                _id: 1,
                user: 1,
                offer: 1,
                want: 1,
                offerVector: 1,
                wantVector: 1,
                location: 1,
                updatedAt: 1,
                modality: 1,
            },
        },
    ]);

    // Merge wildcards (deduped) into the random fallback so they're present even if
    // $sample didn't pick them.
    const wildcards = await fetchWildcardCandidates(activeBaseFilter, geoFilter);
    const seen = new Set(candidates.map((c: any) => c._id.toString()));
    for (const w of wildcards) {
        const id = w._id.toString();
        if (id === bondRequestId.toString() || seen.has(id)) continue;
        seen.add(id);
        candidates.push(w);
    }

    return { candidates, method: 'sample' };
};

export default fetchMatchCandidates;
