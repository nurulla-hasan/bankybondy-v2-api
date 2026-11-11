/* Match read model: one row per PARTICIPANT. BondMatch stores a deal once, under the
 * bond that discovered it; here the same deal fans out to each participant. */
import mongoose from 'mongoose';
import BondMatchFeed from '../bondMatch/bondMatchFeed.model';
import { IBondMatchFeed } from '../bondMatch/bondMatchFeed.interface';
import { MATCHING } from './matching.config';
import type { MatchRecord } from './matching.compute';

/** Canonical deal signature: sorted ids joined by '|'. Exactly the same one
 *  notifyNewMatches uses, so write/serve/notify can't disagree on "same match". */
export const buildMatchKey = (
    ids: Array<string | mongoose.Types.ObjectId>
): string =>
    [...ids]
        .map((id) => id.toString())
        .sort()
        .join('|');

/** Serving rank: `pairBias` is a soft preference for short chains, not a dictator. */
export const rankScoreOf = (
    score: number,
    size: number,
    legacy = MATCHING.legacyRanking
): number => score - (legacy ? 0 : MATCHING.pairBias * (size - 2));

export type FeedDoc = IBondMatchFeed;

/** Expands ONE deal into one row per participant (no duplicate ids). */
export const recordToFeedDocs = (
    record: MatchRecord,
    sourceBondId: string,
    now: Date = new Date(),
    computeRevision = 0
): FeedDoc[] => {
    const matchKey = buildMatchKey(record.ids);
    const sourceBond = new mongoose.Types.ObjectId(sourceBondId);
    const bonds = record.ids.map((id) => new mongoose.Types.ObjectId(id));
    const users = record.users.map((id) => new mongoose.Types.ObjectId(id));

    const seen = new Set<string>();
    const docs: FeedDoc[] = [];
    for (const raw of record.ids) {
        const id = raw.toString();
        if (seen.has(id)) continue;
        seen.add(id);
        docs.push({
            bond: new mongoose.Types.ObjectId(id),
            matchKey,
            bonds,
            users,
            score: record.score,
            parts: record.parts,
            type: record.type,
            size: record.size,
            sourceBond,
            computedAt: now,
            computeRevision,
        });
    }
    return docs;
};

/** Keys of the top-N rows by score (for shadow/verification). */
export const topMatchKeys = (
    rows: Array<{ matchKey?: string; bonds?: unknown[]; score: number }>,
    n: number
): string[] =>
    [...rows]
        .sort((a, b) => b.score - a.score)
        .slice(0, n)
        .map((r) =>
            r.matchKey ??
            buildMatchKey((r.bonds ?? []) as Array<string | mongoose.Types.ObjectId>)
        );

/** Keeps only the `feedMaxRowsPerBond` best rows for a participant and deletes the rest;
 *  serving reads the top `feedScanLimit` by score, so the kept window must cover that scan.
 *  No fixed pass cap: a dense bond must not keep a "top-N + tail" leftover. */
export const trimFeedBond = async (
    bond: mongoose.Types.ObjectId | string,
    computeRevision = Number.MAX_SAFE_INTEGER
): Promise<number> => {
    const bondId =
        typeof bond === 'string' ? new mongoose.Types.ObjectId(bond) : bond;
    let deleted = 0;
    for (let pass = 0; pass < 1000; pass++) {
        const extra = await BondMatchFeed.find({ bond: bondId })
            .sort({ computeRevision: -1, score: -1, _id: 1 })
            .skip(MATCHING.feedMaxRowsPerBond)
            .limit(1000)
            .select('_id computeRevision')
            .lean();
        const removable = extra.filter((row) => (row.computeRevision ?? 0) <= computeRevision);
        if (!removable.length) break;
        const res = await BondMatchFeed.deleteMany({
            $or: removable.map((row) => ({
                _id: row._id,
                computeRevision: (row.computeRevision ?? 0) === 0 ? { $in: [0, null] } : row.computeRevision,
            })),
        });
        const n = res.deletedCount ?? 0;
        deleted += n;
        // If nothing was deleted, further passes can't change state.
        if (n === 0) break;
    }
    return deleted;
};

export const feedUpsertUpdate = (doc: FeedDoc) => {
    const revision = doc.computeRevision ?? 0;
    const storedRevision = { $ifNull: ['$computeRevision', 0] };
    const accepted = { $gte: [revision, storedRevision] };
    const better = { $or: [
        { $gt: [revision, storedRevision] },
        { $and: [{ $eq: [revision, storedRevision] }, { $gt: [doc.score, { $ifNull: ['$score', -1] }] }] },
    ] };
    return [{ $set: {
        bonds: { $cond: [accepted, doc.bonds, '$bonds'] },
        users: { $cond: [accepted, doc.users, '$users'] },
        type: { $cond: [accepted, doc.type, '$type'] },
        size: { $cond: [accepted, doc.size, '$size'] },
        sourceBond: { $cond: [accepted, doc.sourceBond, '$sourceBond'] },
        computedAt: { $cond: [accepted, doc.computedAt, '$computedAt'] },
        computeRevision: { $cond: [accepted, revision, '$computeRevision'] },
        score: { $cond: [better, doc.score, '$score'] },
        parts: { $cond: [better, doc.parts, '$parts'] },
    } }];
};

export interface PersistFeedStats {
    upserts: number;
    removed: number;
    trimmed: number;
}

/**
 * Idempotent upsert of one discoverer's fresh set.
 *
 * - Writes one row per participant with `{ bond, matchKey }`.
 * - Deletes ONLY the rows THIS bond had discovered and no longer finds (bond = sourceBond).
 * - Trims each participant so a dense bond can't pile up thousands of rows again.
 */
export const persistMatchFeed = async (
    sourceBondId: string,
    records: MatchRecord[],
    computeRevision: number
): Promise<PersistFeedStats> => {
    const now = new Date();
    const sourceBond = new mongoose.Types.ObjectId(sourceBondId);
    const keys = new Set<string>();
    const participants = new Map<string, mongoose.Types.ObjectId>();

    const ops: Parameters<typeof BondMatchFeed.bulkWrite>[0] = [];
    for (const record of records) {
        keys.add(buildMatchKey(record.ids));
        for (const doc of recordToFeedDocs(record, sourceBondId, now, computeRevision)) {
            const bondId = doc.bond.toString();
            participants.set(bondId, doc.bond);
            ops.push({
                updateOne: {
                    filter: { bond: doc.bond, matchKey: doc.matchKey },
                    // Pipeline (not a flat $set): preserves the best score/parts if
                    // another discoverer already wrote this deal.
                    update: feedUpsertUpdate(doc) as any,
                    upsert: true,
                },
            });
        }
    }

    let upserts = 0;
    if (ops.length) {
        const res = await BondMatchFeed.bulkWrite(ops, { ordered: false });
        upserts =
            (res.upsertedCount ?? 0) +
            (res.modifiedCount ?? 0) +
            (res.matchedCount ?? 0);
    }

    const removedRes = await BondMatchFeed.deleteMany({
        bond: sourceBond,
        sourceBond,
        matchKey: { $nin: [...keys] },
        $or: [{ computeRevision: { $lte: computeRevision } }, { computeRevision: null }],
    });

    // One trim per participant, in batches: sequential was dozens of round-trips
    // per recompute; unbounded parallel spikes the connection pool.
    const TRIM_CONCURRENCY = 8;
    let trimmed = 0;
    const ids = [...participants.values()];
    for (let i = 0; i < ids.length; i += TRIM_CONCURRENCY) {
        const batch = ids.slice(i, i + TRIM_CONCURRENCY);
        const results = await Promise.all(batch.map((id) => trimFeedBond(id, computeRevision)));
        for (const n of results) trimmed += n;
    }

    return {
        upserts,
        removed: removedRes.deletedCount ?? 0,
        trimmed,
    };
};