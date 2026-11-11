import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import mongoose from 'mongoose';
import { MATCHING } from './matching.config';

function load<T>(file: string, dependencies: Record<string, unknown>): T {
    const filename = path.resolve(__dirname, file);
    const localRequire = createRequire(filename);
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const loaded = { exports: {} };
    vm.runInNewContext(output, { module: loaded, exports: loaded.exports, console, process: { env: {} },
        require: (id: string) => {
            if (Object.hasOwn(dependencies, id)) return dependencies[id];
            if (['./matching.scoring', './matching.schedule', './bondRequest.enum'].includes(id)) return localRequire(id);
            throw new Error(`Unstubbed matching dependency: ${id}`);
        },
    }, { filename });
    return loaded.exports as T;
}

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const U = '111111111111111111111111', V = '222222222222222222222222';
const snapshot = Object.freeze({ candidateMode: 'knn' as const, frontierEnabled: false, frontierSeeds: 1,
    surpriseFloor: 0.8, surpriseMargin: 0.1, cacheTtlMinutes: 60, sweepEnabled: false,
    sweepBatch: 10, sweepCron: '* * * * *', revision: 3, computeRevision: 2, updatedAt: new Date().toISOString(), updatedBy: null });
const source = () => ({ _id: new mongoose.Types.ObjectId(A), user: U, offer: 'surprise', want: 'surprise',
    offerVector: [1], wantVector: [1], modality: 'online', matchesGen: 1, createdAt: new Date() });
const candidate = () => ({ ...source(), _id: new mongoose.Types.ObjectId(B), user: V });

function computeHarness() {
    const state = { reads: 0, seen: [] as unknown[], deletes: [] as any[], inserts: [] as any[], feeds: [] as any[],
        revision: 0, generation: 1, sealed: false, failure: null as any, ended: false };
    const engine = load<typeof import('./matching.compute')>('./matching.compute.ts', {
        mongoose: { ...mongoose, startSession: async () => ({
            withTransaction: async (callback: () => Promise<void>) => { if (state.failure) throw state.failure; await callback(); },
            endSession: async () => { state.ended = true; },
        }) },
        '../normalUser/normalUser.model': { find: () => ({ select: () => ({ lean: async () => [] }) }) },
        '../bondMatch/bondMatch.model': {
            deleteMany: async (filter: any) => { state.deletes.push(filter); },
            insertMany: async (rows: any[]) => { state.inserts.push(...rows); },
        },
        './bondRequest.model': { updateOne: async (filter: any, update: any) => {
            const generation = typeof filter.matchesGen === 'number' ? filter.matchesGen === state.generation : filter.matchesGen.$in.includes(state.generation);
            const accepted = generation && state.revision <= filter.$or[0].matchesComputeRevision.$lte;
            if (accepted) { state.sealed = true; state.revision = update.$set.matchesComputeRevision; }
            return { matchedCount: Number(accepted) };
        } },
        './matching.candidates': { fetchMatchCandidates: async (...args: unknown[]) => { state.seen.push(args[4]); return { candidates: [candidate()] }; } },
        './matching.config': { MATCHING: { ...MATCHING, feedWrite: true, feedRead: true } },
        './matching.feed': { persistMatchFeed: async (...args: any[]) => { state.feeds.push(args); return { upserts: 1, trimmed: 0 }; } },
        '../settings/matchingSettings.service': { getMatchingSettings: async () => { state.reads++; return snapshot; } },
        '../../middlewares/metrics': { bondMatchFeedTrimDeletedTotal: { inc() {} }, bondMatchFeedUpsertsTotal: { inc() {} }, bondMatchFeedWriteErrorsTotal: { inc() {} } },
        '../../shared/logger': { logger: { warn() {}, error() {} } },
    });
    return { engine, state };
}

export async function runMatchingRuntimeTests() {
    const cases: [string, () => Promise<void>][] = [
        ['compute pins one settings snapshot through candidates, scoring, stores and seal', async () => {
            const { engine, state } = computeHarness();
            const rows = await engine.computeAndCacheMatches(source(), U);
            assert.equal(state.reads, 1); assert.equal(state.seen[0], snapshot);
            assert.ok(rows.length > 0); assert.ok(rows[0].parts.sem > 0.7);
            assert.ok(state.inserts.every((row) => row.computeRevision === 2));
            assert.equal(state.feeds[0][2], 2); assert.equal(state.revision, 2); assert.equal(state.sealed, true);
        }],
        ['lowering floor and margin lowers real compute results', async () => {
            const { engine } = computeHarness();
            const high = await engine.computeMatchesForBond(source(), U, snapshot);
            const low = await engine.computeMatchesForBond(source(), U, { ...snapshot, surpriseFloor: 0.5, surpriseMargin: 0 });
            assert.ok(high[0].score > low[0].score);
            assert.ok(high[0].parts.sem > low[0].parts.sem);
        }],
        ['delayed job cannot overwrite a newer seal', async () => {
            const { engine, state } = computeHarness(); state.revision = 3;
            await engine.computeAndCacheMatches(source(), U);
            assert.equal(state.revision, 3); assert.equal(state.sealed, false);
            assert.equal(state.deletes[0].$or[0].computeRevision.$lte, 2);
        }],
        ['concurrent invalidation still prevents sealing', async () => {
            const { engine, state } = computeHarness(); state.generation = 2;
            await engine.computeAndCacheMatches(source(), U);
            assert.equal(state.sealed, false);
        }],
        ['unrelated transaction failures propagate without unguarded retry', async () => {
            const { engine, state } = computeHarness(); state.failure = Object.assign(new Error('write conflict'), { code: 112 });
            await assert.rejects(engine.persistMatches(A, [], 2), /write conflict/);
            assert.equal(state.deletes.length, 0); assert.equal(state.ended, true);
        }],
        ['standalone fallback retains revision and source guards', async () => {
            const { engine, state } = computeHarness();
            state.failure = Object.assign(new Error('Transaction numbers are only allowed on a replica set member or mongos'), { code: 20 });
            await engine.persistMatches(A, [], 2);
            assert.equal(state.deletes[0].sourceBond.toString(), A);
            assert.equal(state.deletes[0].$or[0].computeRevision.$lte, 2);
            assert.equal(state.deletes[0].$or[1].computeRevision, null);
        }],
        ['candidate mode and frontier seed count come only from pinned snapshot', async () => {
            let calls = 0, atlas = 0;
            const candidates = load<typeof import('./matching.candidates')>('./matching.candidates.ts', {
                mongoose,
                './bondRequest.model': { aggregate: async (pipeline: any[]) => { if (pipeline[0].$vectorSearch) atlas++; return []; } },
                './matching.config': { MATCHING: { ...MATCHING, includeWildcards: false } },
                './matching.vectorStore': { knnSearch: async () => { calls++; return [candidate()]; } },
                '../../shared/logger': { errorLogger: { error() { throw new Error('unexpected sample fallback'); } } },
            });
            await candidates.fetchMatchCandidates(source(), A, U, {}, snapshot);
            assert.equal(calls, 2); assert.equal(atlas, 0);
            await candidates.fetchMatchCandidates(source(), A, U, {}, { ...snapshot, frontierEnabled: true });
            assert.equal(calls, 6);
            await candidates.fetchMatchCandidates(source(), A, U, {}, { ...snapshot, candidateMode: 'vector' });
            assert.equal(calls, 6); assert.equal(atlas, 2);
        }],
    ];
    let pass = 0, fail = 0;
    for (const [name, test] of cases) {
        try { await test(); pass++; } catch (error) { fail++; console.error('FAIL:', name, error); }
    }
    return { pass, fail };
}
