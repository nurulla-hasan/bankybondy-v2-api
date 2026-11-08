import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { mongo } from 'mongoose';
import {
    applyMaintenanceBatch, preflightMaintenance, installIdentityIndex, verifyMaintenance,
    rollbackMaintenanceWrite, reconcileMaintenanceWrite, observedStateGuard,
    type MaintenanceCollection, type MaintenanceDocument, type JournalEvent,
} from './bondMaintenance';
import { maintenanceDatabaseName, parseMaintenanceArguments } from '../../../scripts/bondMaintenanceBootstrap';

const clone = <T>(v: T): T => mongo.BSON.EJSON.parse(mongo.BSON.EJSON.stringify(v), { relaxed: true });
let sequence = 0;
const id = () => new mongo.ObjectId((++sequence).toString(16).padStart(24, '0'));
const row = (patch: MaintenanceDocument = {}) => ({ _id: id(), user: id(), status: 'WAITING_FOR_LINK',
    isPause: false, offer: ' Offer ', want: 'Want', updatedAt: new Date(10), ...patch });

/** Deliberately small in-memory adapter; proves orchestration, not MongoDB query/index/concurrency semantics. */
function memoryCollection(documents: MaintenanceDocument[]) {
    const state = { documents: clone(documents), indexes: [] as MaintenanceDocument[], writes: 0, finds: 0, beforeWrite: undefined as (() => void) | undefined };
    const matches = (d: MaintenanceDocument, q: MaintenanceDocument) => Object.entries(q).every(([k, v]) => {
        if (k === '$and') return isDeepStrictEqual(observedStateGuard(d), q);
        if (v && typeof v === 'object' && '$gt' in v) return String(d[k]) > String(v.$gt);
        if (v && typeof v === 'object' && '$ne' in v) return d[k] !== v.$ne;
        return isDeepStrictEqual(d[k], v);
    });
    const api = {
        find(query: MaintenanceDocument) {
            state.finds++;
            let selected = state.documents.filter(d => matches(d, query)).map(clone);
            const cursor = {
                sort(keys: MaintenanceDocument) { selected.sort((a, b) => {
                    for (const key of Object.keys(keys)) { const diff = String(a[key]).localeCompare(String(b[key])); if (diff) return diff; }
                    return 0;
                }); return cursor; },
                allowDiskUse() { return cursor; },
                batchSize() { return cursor; }, limit(n: number) { selected = selected.slice(0, n); return cursor; },
                async close() {}, async *[Symbol.asyncIterator]() { yield* selected; },
            };
            return cursor;
        },
        async findOne(q: MaintenanceDocument) { return clone(state.documents.find(d => matches(d, q)) ?? null); },
        async updateOne(q: MaintenanceDocument, update: MaintenanceDocument) {
            state.beforeWrite?.(); state.beforeWrite = undefined;
            const target = state.documents.find(d => matches(d, q));
            if (!target) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
            Object.assign(target, clone(update.$set ?? {}));
            for (const k of Object.keys(update.$unset ?? {})) delete target[k];
            state.writes++; return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
        },
        listIndexes() { return { toArray: async () => clone(state.indexes) }; },
        async createIndex(key: MaintenanceDocument, options: MaintenanceDocument) { state.indexes.push({ key, ...options }); state.writes++; return options.name; },
    };
    return { state, collection: api as unknown as MaintenanceCollection };
}

export async function runBondMaintenanceExecutionTests() {
    let passed = 0, failed = 0;
    const test = async (name: string, fn: () => Promise<void> | void) => {
        try { await fn(); passed++; } catch (error) { failed++; console.error(name, error); }
    };
    const journal = () => { const events: JournalEvent[] = []; return { events, write: async (e: JournalEvent) => { events.push(clone(e)); } }; };
    await test('URI and CLI fail closed without defaults or loose acknowledgements', () => {
        for (const uri of [undefined, '', 'mongodb://host', 'mongodb://host/', 'mongodb://host/admin', 'mongodb://host/local', 'mongodb://host/a%2Fb']) assert.throws(() => maintenanceDatabaseName(uri));
        assert.equal(maintenanceDatabaseName('mongodb://host:27017/approved'), 'approved');
        assert.equal(maintenanceDatabaseName('mongodb://host1,host2/approved?replicaSet=rs'), 'approved');
        assert.throws(() => parseMaintenanceArguments(['apply', '--collection', 'bonds'], 'repair'));
        assert.throws(() => parseMaintenanceArguments(['dry-run', '--collection', 'system.users'], 'repair'));
        assert.throws(() => parseMaintenanceArguments(['verify', '--collection', 'bonds', '--create-index'], 'identity'));
        assert.throws(() => parseMaintenanceArguments(['dry-run', '--collection', 'bonds', '--batch-size', '0'], 'repair'));
        assert.equal(parseMaintenanceArguments(['dry-run', '--collection', 'bonds'], 'repair').help, false);
        assert.throws(() => parseMaintenanceArguments(['verify', '--collection', 'bonds'], 'repair'));
        const companions = ['--matches-collection', 'matches', '--feeds-collection', 'feeds', '--users-collection', 'users'];
        assert.equal(parseMaintenanceArguments(['verify', '--collection', 'bonds', ...companions, '--reconcile-from', 'actual.jsonl'], 'repair').help, false);
        assert.equal(parseMaintenanceArguments(['reconcile', '--collection', 'bonds', ...companions, '--manifest', 'actual.jsonl', '--confirm-db', 'approved', '--write-window-confirmed'], 'repair').help, false);
        assert.throws(() => parseMaintenanceArguments(['reconcile', '--collection', 'bonds', ...companions, '--manifest', 'actual.jsonl'], 'repair'));
    });
    await test('legacy collisions include missing isLinked and pause, with zero writes', async () => {
        const owner = id(); const db = memoryCollection([row({ user: owner, offer: ' Cafe\u0301 ' }), row({ user: owner, offer: 'CAFÉ', isPause: true, isLinked: false })]);
        const report = await preflightMaintenance(db.collection, 1);
        assert.equal(report.collisions, 1);
        const log = journal();
        await assert.rejects(applyMaintenanceBatch(db.collection, 'repair', { journal: log.write, writeWindowConfirmed: true }));
        assert.equal(db.state.writes, 0);
        assert.equal(log.events.some(e => e.event === 'prepared'), false);
    });
    await test('preflight uses one cursor and blocks rather than truncating a capped owner', async () => {
        const owner = id(); const db = memoryCollection([row({ user: owner, offer: 'A' }), row({ user: owner, offer: 'B' })]);
        const report = await preflightMaintenance(db.collection, 1, 1);
        assert.equal(db.state.finds, 1); assert.equal(db.state.writes, 0);
        assert.equal(report.complete, false); assert.equal(report.invalid, 1);
        assert.match(report.samples[0].issue, /cap exceeded/);
    });
    await test('per-owner cap resets and duplicate counting stays complete at the cap', async () => {
        const a = id(), b = id();
        const db = memoryCollection([row({ user: b, offer: 'A' }), row({ user: a, offer: ' A ' }), row({ user: a, offer: 'a' }), row({ user: a, offer: 'A' })]);
        const report = await preflightMaintenance(db.collection, 1, 1);
        assert.equal(report.complete, true); assert.equal(report.collisions, 3); assert.equal(report.invalid, 0);
        assert.equal(db.state.finds, 1);
    });
    await test('invalid flags anywhere block the entire repair before first write', async () => {
        const db = memoryCollection([row(), row({ isLinked: null })]); const log = journal();
        await assert.rejects(applyMaintenanceBatch(db.collection, 'repair', { journal: log.write, writeWindowConfirmed: true }));
        assert.equal(db.state.writes, 0);
    });
    await test('partial batch, cursor resume and rerun preserve timestamps and defaults', async () => {
        const db = memoryCollection([row(), row()]); const log = journal();
        const first = await applyMaintenanceBatch(db.collection, 'repair', { journal: log.write, maxDocuments: 1, writeWindowConfirmed: true });
        assert.equal(first.applied, 1); assert.equal(first.exhausted, false);
        const second = await applyMaintenanceBatch(db.collection, 'repair', { journal: log.write, after: first.after!, maxDocuments: 10, writeWindowConfirmed: true });
        assert.equal(second.applied, 1); assert.equal(second.exhausted, true);
        const again = await applyMaintenanceBatch(db.collection, 'repair', { journal: log.write, writeWindowConfirmed: true });
        assert.equal(again.applied, 0); assert.equal(db.state.writes, 2);
        assert.ok(db.state.documents.every(d => d.updatedAt.getTime() === 10 && d.matchesGen === 0 && d.matchesNextAt.getTime() === 0));
    });
    await test('a concurrent mutation loses CAS and checkpoint does not skip that row', async () => {
        const db = memoryCollection([row()]); const log = journal();
        db.state.beforeWrite = () => { db.state.documents[0].matchesGen = 8; };
        const result = await applyMaintenanceBatch(db.collection, 'repair', { journal: log.write, writeWindowConfirmed: true });
        assert.equal(result.conflict, true); assert.equal(result.after, null); assert.equal(db.state.writes, 0);
        assert.equal(db.state.documents[0].matchesGen, 8);
        assert.equal(log.events.some(e => e.event === 'applied'), false);
    });
    await test('failure to persist intent prevents a database write', async () => {
        const db = memoryCollection([row()]);
        await assert.rejects(applyMaintenanceBatch(db.collection, 'repair', { writeWindowConfirmed: true,
            journal: async e => { if (e.event === 'prepared') throw new Error('disk unavailable'); } }));
        assert.equal(db.state.writes, 0);
    });
    await test('rollback requires applied record, restores absence, and skips later changes', async () => {
        const db = memoryCollection([row()]); const log = journal();
        await applyMaintenanceBatch(db.collection, 'repair', { journal: log.write, writeWindowConfirmed: true });
        await assert.rejects(rollbackMaintenanceWrite(db.collection, log.events.find(e => e.event === 'prepared')!, log.write));
        const applied = log.events.find(e => e.event === 'applied')!;
        assert.equal(await rollbackMaintenanceWrite(db.collection, applied, log.write), true);
        assert.equal('isLinked' in db.state.documents[0], false);
        assert.equal('matchesGen' in db.state.documents[0], false);
        assert.equal(await rollbackMaintenanceWrite(db.collection, applied, log.write), false);
    });
    await test('identity cutover requires coverage, exact metadata and is idempotent', async () => {
        const db = memoryCollection([row({ isLinked: false })]); const log = journal();
        await assert.rejects(installIdentityIndex(db.collection, { journal: log.write, writeWindowConfirmed: true }));
        assert.equal(db.state.writes, 0);
        await applyMaintenanceBatch(db.collection, 'identity', { journal: log.write, writeWindowConfirmed: true });
        await installIdentityIndex(db.collection, { journal: log.write, writeWindowConfirmed: true });
        await installIdentityIndex(db.collection, { journal: log.write, writeWindowConfirmed: true });
        assert.equal(db.state.indexes.length, 1);
        assert.equal((await verifyMaintenance(db.collection, 'identity')).pendingKeys, 0);
        db.state.indexes[0].unique = false;
        await assert.rejects(verifyMaintenance(db.collection, 'identity'));
    });
    await test('identity backfill waits for repair and cutover requires write-window acknowledgement', async () => {
        const db = memoryCollection([row()]); const log = journal();
        await assert.rejects(applyMaintenanceBatch(db.collection, 'identity', { journal: log.write, writeWindowConfirmed: true }));
        await assert.rejects(installIdentityIndex(db.collection, { journal: log.write, writeWindowConfirmed: false }));
        assert.equal(db.state.writes, 0);
    });
    await test('an empty explicitly injected collection receives the index once', async () => {
        const db = memoryCollection([]); const log = journal();
        await installIdentityIndex(db.collection, { journal: log.write, writeWindowConfirmed: true });
        assert.equal(db.state.indexes.length, 1);
        assert.equal((await verifyMaintenance(db.collection, 'identity')).scanned, 0);
    });
    await test('existing incompatible index blocks backfill before writes', async () => {
        const db = memoryCollection([row({ isLinked: false })]); const log = journal();
        db.state.indexes.push({ name: 'bond_identity_v1_unique', key: { user: 1 }, unique: true });
        await assert.rejects(applyMaintenanceBatch(db.collection, 'identity', { journal: log.write, writeWindowConfirmed: true }));
        assert.equal(db.state.writes, 0);
    });
    await test('reconciliation only accepts actual repair records and propagates failures', async () => {
        const db = memoryCollection([row({ isPause: null, isLinked: false })]); const log = journal();
        await applyMaintenanceBatch(db.collection, 'repair', { journal: log.write, writeWindowConfirmed: true });
        const applied = log.events.find(e => e.event === 'applied')!;
        let active: boolean | undefined;
        await reconcileMaintenanceWrite(db.collection, applied, { invalidateAndRefresh: async (_, a) => { active = a; }, recalculateActiveBonds: async () => {}, verify: async () => true }, log.write);
        assert.equal(active, false); assert.ok(log.events.some(e => e.event === 'reconciled'));
        await assert.rejects(reconcileMaintenanceWrite(db.collection, applied, { invalidateAndRefresh: async () => { throw new Error('failed'); }, recalculateActiveBonds: async () => {}, verify: async () => true }, log.write));
        await assert.rejects(reconcileMaintenanceWrite(db.collection, applied, { invalidateAndRefresh: async () => {}, recalculateActiveBonds: async () => {}, verify: async () => false }, log.write));
    });
    return { pass: passed, fail: failed };
}
