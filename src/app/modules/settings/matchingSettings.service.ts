import httpStatus from 'http-status';
import { z } from 'zod';
import config from '../../config';
import AppError from '../../error/appError';
import { errorLogger } from '../../shared/logger';
import { expresionCron } from '../../utilities/expresionCron';
import { MATCHING } from '../bondRequest/matching.config';
import { MatchingSettingsSnapshot, MatchingSettingsValues } from './matchingSettings.interface';
import { MatchingSettings, MATCHING_SETTINGS_ID, MatchingSettingsRecord } from './matchingSettings.model';
import { matchingSettingsPatchSchema, matchingSettingsValuesSchema } from './matchingSettings.validation';

const snapshotSchema = matchingSettingsValuesSchema.extend({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    computeRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    updatedAt: z.string().datetime(),
    updatedBy: z.string().min(1).nullable(),
});
const computeFields = new Set<keyof MatchingSettingsValues>([
    'candidateMode', 'frontierEnabled', 'frontierSeeds', 'surpriseFloor', 'surpriseMargin',
]);
const CACHE_MS = 5000;
let cached: Readonly<MatchingSettingsSnapshot> | undefined;
let expiresAt = 0;
let inFlight: Promise<Readonly<MatchingSettingsSnapshot>> | undefined;

function assertServingTtl(cacheTtlMinutes: number | undefined): void {
    if (cacheTtlMinutes !== undefined && cacheTtlMinutes > MATCHING.serveTtlMinutes) {
        throw new AppError(httpStatus.BAD_REQUEST, `cacheTtlMinutes must not exceed serving TTL (${MATCHING.serveTtlMinutes} minutes)`);
    }
}

function toSnapshot(row: MatchingSettingsRecord | null): MatchingSettingsSnapshot {
    if (!row) {
        throw new AppError(httpStatus.SERVICE_UNAVAILABLE, 'Matching settings are not initialized; start the API to seed them');
    }
    // An explicit allowlist keeps Mongo internals and unrelated fields out of the DTO.
    const values = Object.fromEntries(Object.keys(matchingSettingsValuesSchema.shape).map((key) => [key, row[key]]));
    const snapshot = snapshotSchema.parse({
        ...values,
        revision: row.revision,
        computeRevision: row.computeRevision ?? 0,
        updatedAt: new Date(row.updatedAt).toISOString(),
        updatedBy: row.updatedBy,
    }) as MatchingSettingsSnapshot;
    assertServingTtl(snapshot.cacheTtlMinutes);
    return Object.freeze(snapshot);
}

function accept(snapshot: MatchingSettingsSnapshot): Readonly<MatchingSettingsSnapshot> {
    // Late reads (including reads begun before a PATCH) cannot roll the process back.
    if (!cached || snapshot.revision > cached.revision) cached = snapshot;
    expiresAt = Date.now() + CACHE_MS;
    return cached;
}

/** Strict fresh read for HTTP and writes: shares I/O, but never hides DB errors. */
export function readMatchingSettingsFresh(): Promise<Readonly<MatchingSettingsSnapshot>> {
    if (!inFlight) {
        inFlight = (async () => {
            const row = await MatchingSettings.findById(MATCHING_SETTINGS_ID).lean();
            return accept(toSnapshot(row));
        })().catch((error: unknown) => {
            if (cached) {
                // Bound retries during an outage; force/HTTP still bypass this interval.
                expiresAt = Date.now() + CACHE_MS;
                errorLogger.warn('[matching settings] refresh failed; retaining last valid snapshot', {
                    revision: cached.revision,
                    errorName: error instanceof Error ? error.name : 'UnknownError',
                });
            }
            throw error;
        }).finally(() => { inFlight = undefined; });
    }
    return inFlight;
}

/** Runtime accessor only. Workers must not seed with their own environment. */
export async function getMatchingSettings(force = false): Promise<Readonly<MatchingSettingsSnapshot>> {
    if (!force && cached && Date.now() < expiresAt) return cached;
    try {
        return await readMatchingSettingsFresh();
    } catch (error: unknown) {
        if (cached) return cached;
        throw error;
    }
}

/** API bootstrap only, after Mongo connects and before HTTP starts listening. */
export async function initializeMatchingSettings(): Promise<MatchingSettingsSnapshot> {
    const existing = await MatchingSettings.findById(MATCHING_SETTINGS_ID).lean();
    if (existing) return accept(toSnapshot(existing));

    // Only construct defaults when missing. Never import matching.sweep (side effects).
    const seed = matchingSettingsValuesSchema.parse({
        candidateMode: process.env.MATCH_CANDIDATE_MODE === 'knn' ? 'knn' : 'vector',
        frontierEnabled: MATCHING.frontierEnabled,
        frontierSeeds: MATCHING.frontierSeeds,
        cacheTtlMinutes: MATCHING.cacheTtlMinutes,
        surpriseFloor: MATCHING.surpriseFloor,
        surpriseMargin: MATCHING.surpriseMargin,
        sweepEnabled: (process.env.MATCH_SWEEP_ENABLED ?? (config.redis_url ? 'true' : 'false')).toLowerCase() === 'true',
        sweepBatch: Math.min(Math.max(Number(process.env.MATCH_SWEEP_BATCH) || 1500, 1), 20000),
        sweepCron: expresionCron('MATCH_SWEEP_CRON', '*/5 * * * *'),
    });
    assertServingTtl(seed.cacheTtlMinutes);
    const now = new Date();
    try {
        const row = await MatchingSettings.findOneAndUpdate(
            { _id: MATCHING_SETTINGS_ID },
            { $setOnInsert: { ...seed, revision: 0, computeRevision: 0, updatedBy: null, createdAt: now, updatedAt: now } },
            // Automatic timestamps would mutate an existing winner of a creation race.
            { upsert: true, new: true, timestamps: false, runValidators: true, setDefaultsOnInsert: false }
        ).lean();
        return accept(toSnapshot(row));
    } catch (error: unknown) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw error;
        // Another API process won the unique _id insert. Its persisted values win.
        return accept(toSnapshot(await MatchingSettings.findById(MATCHING_SETTINGS_ID).lean()));
    }
}

export async function updateMatchingSettings(input: unknown, actorId: string): Promise<MatchingSettingsSnapshot> {
    // validateRequest discards parsed output. Parse here to actually use trimmed values.
    const { expectedRevision, ...patch } = matchingSettingsPatchSchema.parse(input);
    z.string().trim().min(1).parse(actorId);
    assertServingTtl(patch.cacheTtlMinutes);
    const current = await readMatchingSettingsFresh();
    const conflict = () => new AppError(httpStatus.CONFLICT, 'Matching settings changed; reload and try again', 'MATCHING_SETTINGS_CONFLICT');
    if (current.revision !== expectedRevision) throw conflict();

    const changed = Object.entries(patch).filter(([key, value]) => value !== undefined && value !== current[key]);
    const computeChanged = changed.some(([key]) => computeFields.has(key as keyof MatchingSettingsValues));
    if (changed.length && (current.revision === Number.MAX_SAFE_INTEGER || (computeChanged && current.computeRevision === Number.MAX_SAFE_INTEGER))) {
        throw new AppError(httpStatus.CONFLICT, 'Matching settings revision limit reached');
    }
    const update = changed.length ? {
        $set: { ...Object.fromEntries(changed), updatedBy: actorId, updatedAt: new Date() },
        $inc: { revision: 1, ...(computeChanged ? { computeRevision: 1 } : {}) },
    } : {
        // Still compare atomically for no-ops, without changing revisions or audit data.
        $set: { revision: expectedRevision },
    };
    const row = await MatchingSettings.findOneAndUpdate(
        { _id: MATCHING_SETTINGS_ID, revision: expectedRevision },
        update,
        { new: true, runValidators: true, timestamps: false }
    ).lean();
    if (!row) throw conflict();
    const snapshot = toSnapshot(row);
    accept(snapshot);
    return snapshot;
}
