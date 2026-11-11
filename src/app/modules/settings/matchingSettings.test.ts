import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import jwt from 'jsonwebtoken';
import catchAsync from '../../utilities/catchasync';
import AppError from '../../error/appError';
import { USER_ROLE } from '../user/user.constant';

// Like bondsServiceTestLoader: fail closed on imports so tests cannot load config,
// start clients, or read dotenv. Only the DB boundary and runtime controls are faked.
function loadSource<T>(file: string, dependencies: Record<string, unknown>, env: Record<string, string> = {}, clock: { new(value?: any): Date; now(): number } = Date): T {
    const filename = path.resolve(__dirname, file);
    const localRequire = createRequire(filename);
    const safe = new Set(['http-status', 'zod', 'node-cron', 'express', '../../error/appError',
        './matchingSettings.validation', '../../utilities/catchasync', '../../utilities/sendResponse',
        '../../middlewares/validateRequest', '../user/user.constant', '../utilities/objectId', '../helper/socketToken']);
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const loaded = { exports: {} };
    vm.runInNewContext(output, {
        module: loaded, exports: loaded.exports, Date: clock, console,
        process: { env },
        require: (id: string) => {
            if (Object.hasOwn(dependencies, id)) return dependencies[id];
            if (safe.has(id)) return localRequire(id);
            throw new Error(`Unstubbed settings test dependency: ${id}`);
        },
    }, { filename });
    return loaded.exports as T;
}
import { matchingSettingsPatchSchema, matchingSettingsValuesSchema } from './matchingSettings.validation';

const values = {
    candidateMode: 'vector' as const,
    frontierEnabled: true,
    cacheTtlMinutes: 60,
    surpriseFloor: 0.45,
    surpriseMargin: 0.1,
    frontierSeeds: 5,
    sweepEnabled: false,
    sweepBatch: 1500,
    sweepCron: '*/5 * * * *',
};

type Case = [string, () => void | Promise<void>];
const cases: Case[] = [
    ['valid values and trimmed five/six-field cron syntax', () => {
        assert.deepEqual(matchingSettingsValuesSchema.parse(values), values);
        assert.equal(matchingSettingsPatchSchema.parse({ expectedRevision: 0, sweepCron: '  */5 * * * *  ' }).sweepCron, values.sweepCron);
        assert.equal(matchingSettingsPatchSchema.safeParse({ expectedRevision: 0, sweepCron: '0 */5 * * * *' }).success, true);
    }],
    ['cron input cannot trigger unbounded node-cron range expansion', () => {
        let calls = 0;
        const validation = loadSource<typeof import('./matchingSettings.validation')>('./matchingSettings.validation.ts', {
            'node-cron': { validate: () => { calls++; return true; } },
        });
        for (const sweepCron of ['0-1000000000 * * * *', '0 0 * Jan-999999999 *', '0 0 * JanJanJanJanJanJan-Jan *', '*'.repeat(121)]) {
            assert.equal(validation.matchingSettingsPatchSchema.safeParse({ expectedRevision: 0, sweepCron }).success, false);
        }
        assert.equal(calls, 0, 'unsafe expressions must be rejected before node-cron expands ranges');
        for (const sweepCron of ['0 0 * January-March Monday-Friday', '*/120 * * * * *', '0-30/2 * * * *', '0001 * * * *']) {
            assert.equal(matchingSettingsPatchSchema.safeParse({ expectedRevision: 0, sweepCron }).success, true, sweepCron);
        }
    }],
    ['patch requires revision and at least one writable value', () => {
        for (const input of [{}, { expectedRevision: 0 }, { sweepEnabled: true }, { expectedRevision: -1, sweepEnabled: true }, { expectedRevision: 0.5, sweepEnabled: true }, { expectedRevision: 0, sweepEnabled: undefined }]) {
            assert.equal(matchingSettingsPatchSchema.safeParse(input).success, false);
        }
    }],
    ['strict allowlist rejects operators, unknown fields and audit injection', () => {
        for (const key of ['$set', '$where', 'revision', 'computeRevision', 'updatedAt', 'updatedBy', '_id', 'createdAt', 'other']) {
            assert.equal(matchingSettingsPatchSchema.safeParse({ expectedRevision: 0, sweepEnabled: true, [key]: 'injected' }).success, false, key);
        }
        assert.equal(matchingSettingsPatchSchema.safeParse(JSON.parse('{"expectedRevision":0,"sweepEnabled":true,"__proto__":{"admin":true}}')).success, false);
    }],
    ['all scalar bounds reject coercion, fractions and out-of-range values', () => {
        const invalid: Record<string, unknown[]> = {
            candidateMode: ['hybrid', 'KNN', 1], frontierEnabled: ['true', 1], sweepEnabled: ['false', null],
            cacheTtlMinutes: [-1, 43201, 1.5, '60', Infinity], frontierSeeds: [0, 21, 1.5],
            surpriseFloor: [-0.1, 1.1, NaN], surpriseMargin: [-0.1, 1.1], sweepBatch: [0, 20001, 1.5],
            sweepCron: ['', 'not cron', '* * * * *; command', '*'.repeat(121)],
        };
        for (const [key, inputs] of Object.entries(invalid)) {
            for (const input of inputs) assert.equal(matchingSettingsPatchSchema.safeParse({ expectedRevision: 0, [key]: input }).success, false, `${key}: ${String(input)}`);
        }
        assert.equal(matchingSettingsValuesSchema.safeParse({ ...values, cacheTtlMinutes: 0, frontierSeeds: 1, surpriseFloor: 0, surpriseMargin: 1, sweepBatch: 20000 }).success, true);
        assert.equal(matchingSettingsValuesSchema.safeParse({ ...values, cacheTtlMinutes: 43200, frontierSeeds: 20, sweepBatch: 1 }).success, true);
    }],
];

type Row = Record<string, any>;
const stored = (overrides: Row = {}): Row => ({
    _id: 'matching', ...values, revision: 0, computeRevision: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: new Date('2026-01-01T00:00:00.000Z'), updatedBy: null,
    ...overrides,
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function harness(initial: Row | null = stored(), env: Record<string, string> = {}, matching: Row = {}, redis = false) {
    let now = Date.parse('2026-02-01T00:00:00.000Z');
    class Clock extends Date {
        constructor(value?: any) { super(value === undefined ? now : value); }
        static now() { return now; }
    }
    const state = {
        row: initial, reads: 0, writes: [] as Row[], logs: [] as unknown[],
        readsQueue: [] as (() => Promise<Row | null>)[],
        beforeWrite: null as (() => void) | null,
        error: null as Error | null,
    };
    const model = {
        findById: (id: string) => ({ lean: async () => {
            assert.equal(id, 'matching');
            state.reads++;
            if (state.readsQueue.length) return state.readsQueue.shift()!();
            if (state.error) throw state.error;
            return state.row ? { ...state.row } : null;
        } }),
        findOneAndUpdate: (filter: Row, update: Row, options: Row) => ({ lean: async () => {
            state.writes.push({ filter, update, options });
            assert.equal(filter._id, 'matching');
            assert.equal(options.new, true);
            assert.equal(options.timestamps, false);
            assert.equal(options.runValidators, true);
            if (state.beforeWrite) { const run = state.beforeWrite; state.beforeWrite = null; run(); }
            if (state.error) throw state.error;
            if (options.upsert) {
                assert.deepEqual(Object.keys(update), ['$setOnInsert']);
                if (!state.row) state.row = { _id: filter._id, ...update.$setOnInsert };
            } else {
                if (!state.row || state.row.revision !== filter.revision) return null;
                Object.assign(state.row, update.$set);
                for (const [key, amount] of Object.entries(update.$inc || {})) state.row[key] = (state.row[key] || 0) + Number(amount);
            }
            return { ...state.row };
        } }),
    };
    const log = { error: (...args: unknown[]) => state.logs.push(args), warn: (...args: unknown[]) => state.logs.push(args) };
    const cronHelper = loadSource('../../utilities/expresionCron.ts', { '../shared/logger': { errorLogger: log } }, env);
    const service = loadSource<typeof import('./matchingSettings.service')>('./matchingSettings.service.ts', {
        './matchingSettings.model': { MatchingSettings: model, MATCHING_SETTINGS_ID: 'matching' },
        '../../config': { redis_url: redis ? 'fake-redis-present' : undefined },
        '../bondRequest/matching.config': { MATCHING: { ...values, serveTtlMinutes: 2880, ...matching } },
        '../../utilities/expresionCron': cronHelper,
        '../../shared/logger': { errorLogger: log, logger: log },
    }, env, Clock);
    return { service, state, advance: (ms: number) => { now += ms; } };
}

cases.push(
    ['initializer seeds effective defaults once and preserves existing timestamps/audit', async () => {
        const h = harness(null);
        const first = await h.service.initializeMatchingSettings();
        assert.deepEqual(JSON.parse(JSON.stringify(first)), { ...values, revision: 0, computeRevision: 0, updatedAt: '2026-02-01T00:00:00.000Z', updatedBy: null });
        h.advance(6000);
        assert.deepEqual(await h.service.initializeMatchingSettings(), first);
        assert.equal(h.state.writes.length, 1);
        assert.equal(h.state.row!.createdAt.toISOString(), first.updatedAt);
    }],
    ['persisted settings win even when seed-only controls are invalid', async () => {
        const h = harness(stored({ revision: 7, sweepBatch: 50 }), { MATCH_SWEEP_BATCH: '1.5' }, { frontierSeeds: 2.5 });
        assert.equal((await h.service.initializeMatchingSettings()).revision, 7);
        assert.equal(h.state.writes.length, 0);
    }],
    ['seed uses exact candidate mode, Redis default, sweep clamps and cron fallback', async () => {
        const h = harness(null, { MATCH_CANDIDATE_MODE: 'knn', MATCH_SWEEP_BATCH: '999999', MATCH_SWEEP_CRON: 'bad cron' }, { frontierEnabled: false, frontierSeeds: 12, cacheTtlMinutes: 90 }, true);
        const s = await h.service.initializeMatchingSettings();
        assert.equal(s.candidateMode, 'knn'); assert.equal(s.sweepEnabled, true);
        assert.equal(s.sweepBatch, 20000); assert.equal(s.sweepCron, values.sweepCron);
        assert.equal(s.frontierEnabled, false); assert.equal(s.frontierSeeds, 12); assert.equal(s.cacheTtlMinutes, 90);
        assert.equal(h.state.logs.length, 1);
        const other = await harness(null, { MATCH_CANDIDATE_MODE: 'KNN', MATCH_SWEEP_ENABLED: 'FALSE', MATCH_SWEEP_BATCH: '-3' }, {}, true).service.initializeMatchingSettings();
        assert.equal(other.candidateMode, 'vector'); assert.equal(other.sweepEnabled, false); assert.equal(other.sweepBatch, 1);
    }],
    ['invalid effective seed is reported rather than silently replaced', async () => {
        const h = harness(null, { MATCH_SWEEP_BATCH: '1.5' });
        await assert.rejects(h.service.initializeMatchingSettings());
        assert.equal(h.state.writes.length, 0);
        await assert.rejects(harness(null, {}, { cacheTtlMinutes: 3000, serveTtlMinutes: 2880 }).service.initializeMatchingSettings());
    }],
    ['atomic seed races return the winner without changing it, including duplicate-key race', async () => {
        for (const duplicate of [false, true]) {
            const h = harness(null);
            const winner = stored({ revision: 4, candidateMode: 'knn', updatedBy: 'winner' });
            h.state.beforeWrite = () => {
                h.state.row = winner;
                if (duplicate) throw Object.assign(new Error('duplicate'), { code: 11000 });
            };
            const s = await h.service.initializeMatchingSettings();
            assert.equal(s.revision, 4); assert.equal(s.updatedBy, 'winner');
            assert.equal(s.updatedAt, winner.updatedAt.toISOString());
        }
    }],
    ['worker reads never seed; initial absence or database errors fail visibly', async () => {
        const h = harness(null);
        await assert.rejects(h.service.getMatchingSettings(), /initializ/i);
        assert.equal(h.state.writes.length, 0);
        h.state.error = new Error('database unavailable');
        await assert.rejects(h.service.getMatchingSettings(), /database unavailable/);
        await assert.rejects(h.service.initializeMatchingSettings(), /database unavailable/);
    }],
    ['partial patch uses canonical values, preserves omissions and server owns audit', async () => {
        const h = harness();
        const s = await h.service.updateMatchingSettings({ expectedRevision: 0, sweepCron: '  0 * * * *  ', sweepBatch: 20 }, 'actor-1');
        assert.equal(s.sweepCron, '0 * * * *'); assert.equal(s.sweepBatch, 20);
        assert.equal(s.candidateMode, values.candidateMode); assert.equal(s.surpriseFloor, values.surpriseFloor);
        assert.equal(s.revision, 1); assert.equal(s.computeRevision, 0);
        assert.equal(s.updatedBy, 'actor-1'); assert.equal(s.updatedAt, '2026-02-01T00:00:00.000Z');
        assert.equal((await h.service.getMatchingSettings()).revision, 1);
        for (const key of ['updatedBy', 'updatedAt', 'revision', 'computeRevision', '$set', '_id']) {
            await assert.rejects(h.service.updateMatchingSettings({ expectedRevision: 1, sweepBatch: 30, [key]: 'forged' }, 'actor-1'));
        }
        assert.equal(h.state.row!.sweepBatch, 20);
    }],
    ['TTL cannot exceed serving TTL; invalid input is rejected before database I/O', async () => {
        const h = harness();
        await assert.rejects(h.service.updateMatchingSettings({ expectedRevision: 0, cacheTtlMinutes: 2881 }, 'actor'));
        await assert.rejects(h.service.updateMatchingSettings({ expectedRevision: 0, sweepBatch: { $gt: 1 } }, 'actor'));
        assert.equal(h.state.writes.length, 0);
        assert.equal((await h.service.updateMatchingSettings({ expectedRevision: 0, cacheTtlMinutes: 2880 }, 'actor')).cacheTtlMinutes, 2880);
    }],
    ['compute revision increments only for actual retrieval/scoring changes', async () => {
        const changes = { candidateMode: 'knn', frontierEnabled: false, frontierSeeds: 6, surpriseFloor: 0.2, surpriseMargin: 0.3 };
        for (const [key, value] of Object.entries(changes)) {
            const h = harness();
            const s = await h.service.updateMatchingSettings({ expectedRevision: 0, [key]: value }, 'actor');
            assert.equal(s.computeRevision, 1, key); assert.equal(s.revision, 1);
        }
        const h = harness();
        const s = await h.service.updateMatchingSettings({ expectedRevision: 0, ...changes }, 'actor');
        assert.equal(s.computeRevision, 1);
        const next = await h.service.updateMatchingSettings({ expectedRevision: 1, ...changes, sweepEnabled: true, cacheTtlMinutes: 120 }, 'actor');
        assert.equal(next.computeRevision, 1); assert.equal(next.revision, 2);
    }],
    ['actual no-op preserves revisions, timestamp and actor; stale no-op conflicts', async () => {
        const h = harness(stored({ revision: 2, computeRevision: 1, updatedBy: 'original' }));
        const before = await h.service.getMatchingSettings();
        assert.deepEqual(await h.service.updateMatchingSettings({ expectedRevision: 2, sweepCron: ` ${values.sweepCron} `, candidateMode: 'vector' }, 'new-actor'), before);
        await assert.rejects(h.service.updateMatchingSettings({ expectedRevision: 1, candidateMode: 'vector' }, 'actor'), { statusCode: 409 });
    }],
    ['atomic compare-and-update rejects a concurrent edit for changed and no-op patches', async () => {
        for (const sweepBatch of [values.sweepBatch, 20]) {
            const h = harness();
            h.state.beforeWrite = () => { h.state.row = stored({ revision: 1, sweepBatch: 99 }); };
            await assert.rejects(h.service.updateMatchingSettings({ expectedRevision: 0, sweepBatch }, 'actor'), { statusCode: 409 });
            assert.equal(h.state.row!.sweepBatch, 99);
        }
    }],
    ['five-second cache is immutable, single-flight, and force bypasses TTL', async () => {
        const h = harness();
        const wait = deferred<Row | null>();
        h.state.readsQueue.push(() => wait.promise);
        const first = h.service.getMatchingSettings();
        const second = h.service.getMatchingSettings(true);
        wait.resolve(stored());
        const [a, b] = await Promise.all([first, second]);
        assert.equal(a, b); assert.equal(h.state.reads, 1); assert.equal(Object.isFrozen(a), true);
        h.advance(4999); await h.service.getMatchingSettings(); assert.equal(h.state.reads, 1);
        h.advance(1); await h.service.getMatchingSettings(); assert.equal(h.state.reads, 2);
        await h.service.getMatchingSettings(true); assert.equal(h.state.reads, 3);
    }],
    ['late older reads never regress a successful patch or cache revision', async () => {
        const h = harness();
        await h.service.getMatchingSettings();
        const wait = deferred<Row | null>();
        // The update has read revision 0; delay its write while an old refresh starts.
        h.state.beforeWrite = () => {
            h.state.readsQueue.push(() => wait.promise);
            void h.service.getMatchingSettings(true);
        };
        const saved = await h.service.updateMatchingSettings({ expectedRevision: 0, surpriseFloor: 0.2 }, 'actor');
        const pending = h.service.getMatchingSettings(true);
        wait.resolve(stored());
        assert.equal((await pending).revision, saved.revision);
        assert.equal((await h.service.getMatchingSettings()).surpriseFloor, 0.2);
    }],
    ['refresh failure shares a flight, logs and retains last valid; HTTP fresh read rejects', async () => {
        const h = harness();
        const original = await h.service.getMatchingSettings();
        h.advance(5000);
        const wait = deferred<Row | null>();
        h.state.readsQueue.push(() => wait.promise);
        const a = h.service.getMatchingSettings();
        const b = h.service.getMatchingSettings(true);
        const http = h.service.readMatchingSettingsFresh();
        const rejected = assert.rejects(http, /offline/);
        wait.reject(new Error('offline'));
        const results = await Promise.all([a, b]); await rejected;
        assert.equal(results[0], original); assert.equal(results[1], original);
        assert.equal(h.state.reads, 2); assert.ok(h.state.logs.length > 0);
        h.state.row = stored({ revision: 2, frontierSeeds: 21 });
        assert.equal(await h.service.getMatchingSettings(true), original);
        await assert.rejects(h.service.readMatchingSettingsFresh());
        h.state.row = stored({ revision: 3, surpriseFloor: 0.1 });
        assert.equal((await h.service.getMatchingSettings(true)).revision, 3);
    }],
);

function apiHarness(role: string) {
    const h = harness();
    const actor = '111111111111111111111111';
    const secret = 'isolated-settings-test-signing-key';
    const auth = loadSource<{ default: typeof import('../../middlewares/auth').default }>('../../middlewares/auth.ts', {
        '../config': { jwt_access_secret: secret },
        '../utilities/catchasync': { default: catchAsync, __esModule: true },
        '../error/appError': { default: AppError, __esModule: true },
        jsonwebtoken: { default: jwt, __esModule: true },
        '../modules/user/user.model': { User: { findById: async () => ({ role, isVerified: true, profileId: '222222222222222222222222' }) } },
    }).default;
    const controller = loadSource('./matchingSettings.controller.ts', { './matchingSettings.service': h.service });
    const routes = loadSource<{ settingsRoutes: any }>('./matchingSettings.routes.ts', {
        '../../middlewares/auth': { default: auth, __esModule: true },
        './matchingSettings.controller': controller,
    }).settingsRoutes;
    const token = jwt.sign({ id: actor, role: USER_ROLE.superAdmin }, secret); // Fresh DB role must win.
    function request(method: string, body?: unknown, authenticated = true): Promise<{ status: number; body: any }> {
        return new Promise((resolve) => {
            let status = 200;
            const req = { method, url: '/matching', headers: authenticated ? { authorization: `Bearer ${token}` } : {}, body };
            const res = { status: (code: number) => { status = code; return res; }, json: (data: unknown) => resolve({ status, body: data }) };
            routes.handle(req, res, (error?: any) => resolve({ status: error?.statusCode || (error ? 400 : 404), body: error }));
        });
    }
    return { ...h, actor, request };
}

cases.push(
    ['model enforces fixed singleton id, integer bounds and legacy revision zero without a DB', async () => {
        const { MatchingSettings } = await import('./matchingSettings.model');
        const doc = new MatchingSettings(values);
        await doc.validate();
        assert.equal(doc._id, 'matching'); assert.equal(doc.revision, 0); assert.equal(doc.computeRevision, 0);
        assert.equal(doc.updatedBy, null);
        for (const invalid of [{ _id: 'other' }, { frontierSeeds: 1.5 }, { sweepBatch: 20001 }, { cacheTtlMinutes: -1 }, { revision: -1 }, { sweepCron: 'bad' }]) {
            await assert.rejects(new MatchingSettings({ ...values, ...invalid }).validate());
        }
    }],
    ['API requires authentication and blocks ordinary users for both methods', async () => {
        const h = apiHarness(USER_ROLE.user);
        for (const method of ['GET', 'PATCH']) {
            assert.equal((await h.request(method, { expectedRevision: 0, sweepBatch: 10 }, false)).status, 401);
            assert.equal((await h.request(method, { expectedRevision: 0, sweepBatch: 10 })).status, 401);
        }
        assert.equal(h.state.reads, 0); assert.equal(h.state.writes.length, 0);
    }],
    ['admin can read the standard DTO but cannot patch, even with an old superAdmin token', async () => {
        const h = apiHarness(USER_ROLE.admin);
        h.state.row!.privateInternal = 'must not be exposed';
        const result = await h.request('GET');
        assert.equal(result.status, 200); assert.equal(result.body.success, true);
        assert.equal(result.body.data.revision, 0); assert.equal(result.body.data.candidateMode, 'vector');
        assert.equal(result.body.data.privateInternal, undefined); assert.equal(result.body.data._id, undefined);
        assert.equal((await h.request('PATCH', { expectedRevision: 0, sweepBatch: 10 })).status, 401);
        assert.equal(h.state.writes.length, 0);
    }],
    ['superAdmin patch persists canonical fields, uses the session actor and returns 409 on stale input', async () => {
        const h = apiHarness(USER_ROLE.superAdmin);
        const result = await h.request('PATCH', { expectedRevision: 0, sweepCron: '  0 * * * *  ' });
        assert.equal(result.status, 200); assert.equal(result.body.data.updatedBy, h.actor);
        assert.equal(result.body.data.sweepCron, '0 * * * *'); assert.equal(result.body.data.revision, 1);
        assert.equal((await h.request('PATCH', { expectedRevision: 0, sweepEnabled: true })).status, 409);
        assert.equal((await h.request('PATCH', { expectedRevision: 1, updatedBy: 'forged', sweepEnabled: true })).status, 400);
    }],
    ['settings routes are mounted and API awaits initialization after Mongo, before listening', () => {
        const routes = fs.readFileSync(path.resolve(__dirname, '../../routes/index.ts'), 'utf8');
        assert.match(routes, /path:\s*'\/settings',\s*router:\s*settingsRoutes/);
        const server = fs.readFileSync(path.resolve(__dirname, '../../../server.ts'), 'utf8');
        const connect = server.indexOf('await mongoose.connect(');
        const initialize = server.indexOf('await initializeMatchingSettings()');
        const listen = server.indexOf('server.listen(');
        assert.ok(connect >= 0 && initialize > connect && listen > initialize);
    }],
    ['GET bypasses cache TTL and surfaces DB errors instead of serving cached success', async () => {
        const h = apiHarness(USER_ROLE.admin);
        await h.service.getMatchingSettings();
        h.state.row = stored({ revision: 1, sweepBatch: 99 });
        assert.equal((await h.request('GET')).body.data.sweepBatch, 99);
        h.state.error = new AppError(503, 'test database offline');
        assert.equal((await h.request('GET')).status, 503);
        assert.equal((await h.service.getMatchingSettings(true)).revision, 1);
    }],
);

export async function runMatchingSettingsTests(): Promise<{ pass: number; fail: number }> {
    let pass = 0, fail = 0;
    for (const [name, run] of cases) {
        try { await run(); pass++; }
        catch (error: unknown) { fail++; console.error('FAIL matching settings:', name, error); }
    }
    return { pass, fail };
}

if (require.main === module) {
    void runMatchingSettingsTests().then((result) => {
        console.log('matching settings:', result);
        if (result.fail) process.exitCode = 1;
    });
}
