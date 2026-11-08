import assert from 'node:assert/strict';
import { mongo } from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import { makeWriteDecision, rollbackMaintenanceWrite, type MaintenanceDocument, type MaintenanceCollection } from './bondMaintenance';
import { planScheduleInvalidation, planOwnerFlag, reconciliationScheduleSatisfied,
    reconcileRepairNative, verifyRepairReconciliation, reconciledRollbackManifest, type ReconciliationEvent, type ReconciliationStore,
} from './bondMaintenance.reconcile';

export function runBondReconciliationTests() {
    let passed = 0, failed = 0;
    const test = (name: string, fn: () => void) => { try { fn(); passed++; } catch (e) { failed++; console.error(name, e); } };
    const id = new mongo.ObjectId('000000000000000000000001');
    test('invalidating seeds missing generation and expires agenda without timestamps', () => {
        const before = { _id: id, updatedAt: new Date(100), createdAt: new Date(50) };
        const plan = planScheduleInvalidation(before);
        assert.deepEqual(plan.update, { $set: { matchesGen: 1, matchesNextAt: new Date(0) }, $unset: { matchesComputedAt: '' } });
        assert.equal(plan.after.updatedAt.getTime(), 100);
        assert.equal(plan.after.createdAt.getTime(), 50);
        assert.equal('matchesGen' in before, false);
    });
    test('generation increments once and removes seal but preserves timestamps', () => {
        const before = { _id: id, matchesGen: 4, matchesNextAt: new Date(900), matchesComputedAt: new Date(800), updatedAt: new Date(500) };
        const plan = planScheduleInvalidation(before);
        assert.equal(plan.after.matchesGen, 5);
        assert.equal('matchesComputedAt' in plan.after, false);
        assert.equal(plan.after.updatedAt.getTime(), 500);
        assert.equal(reconciliationScheduleSatisfied(plan.after, plan.after), true);
        assert.equal(reconciliationScheduleSatisfied({ ...plan.after, matchesGen: 6 }, plan.after), true);
        for (const patch of [{ matchesGen: 4 }, { matchesNextAt: new Date(100) }, { matchesComputedAt: new Date(1) }, { updatedAt: new Date(501) }]) assert.equal(reconciliationScheduleSatisfied({ ...plan.after, ...patch }, plan.after), false);
    });
    for (const matchesGen of [null, [], '1', -1, 1.5, Number.MAX_SAFE_INTEGER]) {
        test('malformed or overflowing generation blocks invalidation', () => assert.throws(() => planScheduleInvalidation({ _id: id, matchesGen })));
    }
    test('owner flag writes are exact CAS and do not move owner timestamps', () => {
        const before = { _id: id, hasActiveBonds: true, bondSeq: 8, updatedAt: new Date(20) };
        const plan = planOwnerFlag(before, false);
        assert.deepEqual(plan.update, { $set: { hasActiveBonds: false } });
        assert.equal(plan.after.updatedAt.getTime(), 20);
        assert.equal(plan.after.bondSeq, 8);
        assert.ok(JSON.stringify(plan.filter).includes('$literal'));
    });
    return { pass: passed, fail: failed };
}

const clone = <T>(v: T): T => mongo.BSON.EJSON.parse(mongo.BSON.EJSON.stringify(v), { relaxed: true });
const oid = (n: number) => new mongo.ObjectId(n.toString(16).padStart(24, '0'));
function memory(rows: MaintenanceDocument[]) {
    const data = clone(rows);
    let writes = 0;
    const value = (d: MaintenanceDocument, v: unknown): unknown => {
        if (v === '$$ROOT') return d;
        if (typeof v === 'string' && v.startsWith('$')) return d[v.slice(1)];
        if (!v || typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map(x => value(d, x));
        const expr = v as MaintenanceDocument;
        if ('$literal' in expr) return expr.$literal;
        if ('$type' in expr) {
            const x = value(d, expr.$type);
            return x === undefined ? 'missing' : x === null ? 'null' : x instanceof Date ? 'date'
                : Array.isArray(x) ? 'array' : typeof x === 'object' && (x as mongo.ObjectId)._bsontype === 'ObjectId' ? 'objectId'
                : typeof x === 'number' ? 'double' : typeof x === 'boolean' ? 'bool' : typeof x;
        }
        if ('$eq' in expr) return isDeepStrictEqual(value(d, expr.$eq[0]), value(d, expr.$eq[1]));
        if ('$and' in expr) return expr.$and.every((x: unknown) => value(d, x));
        if ('$in' in expr) return (value(d, expr.$in[1]) as unknown[]).some(x => isDeepStrictEqual(x, value(d, expr.$in[0])));
        return v;
    };
    const match = (d: MaintenanceDocument, q: MaintenanceDocument): boolean => Object.entries(q).every(([k, v]) => {
        if (k === '$expr') return !!value(d, v);
        if (k === '$and') return v.every((x: MaintenanceDocument) => match(d, x));
        if (v && typeof v === 'object' && '$exists' in v) return Object.prototype.hasOwnProperty.call(d, k) === v.$exists;
        if (v && typeof v === 'object' && '$ne' in v) return !isDeepStrictEqual(d[k], v.$ne);
        if (v && typeof v === 'object' && '$in' in v) return v.$in.some((x: unknown) => isDeepStrictEqual(d[k], x));
        if (v && typeof v === 'object' && '$type' in v) return value(d, { $type: `$${k}` }) === v.$type;
        return isDeepStrictEqual(d[k], v) || (Array.isArray(d[k]) && d[k].some((x: unknown) => isDeepStrictEqual(x, v)));
    });
    const project = (d: MaintenanceDocument, options?: MaintenanceDocument) => options?.projection
        ? Object.fromEntries(Object.keys(options.projection).filter(k => k in d).map(k => [k, d[k]]).concat('_id' in options.projection ? [] : [['_id', d._id]])) : d;
    const api = {
        find(q: MaintenanceDocument, options?: MaintenanceDocument) {
            const selected = data.filter(d => match(d, q)).map(d => clone(project(d, options)));
            const cursor = { batchSize() { return cursor; }, async close() {}, async *[Symbol.asyncIterator]() { yield* selected; } }; return cursor;
        },
        async findOne(q: MaintenanceDocument, options?: MaintenanceDocument) { const d = data.find(x => match(x, q)); return d ? clone(project(d, options)) : null; },
        async updateOne(q: MaintenanceDocument, update: MaintenanceDocument) {
            const d = data.find(x => match(x, q));
            if (!d) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
            Object.assign(d, clone(update.$set ?? {})); for (const k of Object.keys(update.$unset ?? {})) delete d[k];
            writes++; return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
        },
        async deleteOne(q: MaintenanceDocument) {
            const i = data.findIndex(d => match(d, q)); if (i < 0) return { acknowledged: true, deletedCount: 0 };
            data.splice(i, 1); writes++; return { acknowledged: true, deletedCount: 1 };
        },
    };
    return { data, count: () => writes, collection: api as unknown as MaintenanceCollection };
}
function fixture() {
    const bond = (n: number, patch: MaintenanceDocument = {}) => ({ _id: oid(n), user: oid(100 + n), status: 'WAITING_FOR_LINK', isLinked: false, isPause: false,
        offer: `offer${n}`, want: `want${n}`, matchesGen: n, matchesNextAt: new Date(900), matchesComputedAt: new Date(800), updatedAt: new Date(10), ...patch });
    const root = bond(1, { isPause: true });
    const manifest = makeWriteDecision('repair', { ...root, isPause: null })!.manifest;
    const bonds = memory([root, bond(2), bond(3, { status: 'ONGOING' }), bond(4, { isDeleted: true, isLinked: true, isPause: true })]);
    const users = memory([1, 2, 3, 4].map(n => ({ _id: oid(100 + n), hasActiveBonds: true, updatedAt: new Date(12) })));
    const matches = memory([
        { _id: oid(201), sourceBond: oid(1), bonds: [oid(1), oid(2)] },
        { _id: oid(202), sourceBond: oid(2), bonds: [oid(1), oid(2)] },
        { _id: oid(203), sourceBond: oid(2), bonds: [oid(2), oid(3)] },
        { _id: oid(204), sourceBond: oid(3), bonds: [oid(3)] },
    ]);
    const feeds = memory([
        { _id: oid(301), bond: oid(2), bonds: [oid(1), oid(2)] },
        { _id: oid(302), bond: oid(3), bonds: [oid(1), oid(3)] },
        { _id: oid(303), bond: oid(3), bonds: [oid(2), oid(3)] },
    ]);
    const entries: ReconciliationEvent[] = [];
    const store: ReconciliationStore = { append: async e => { entries.push(clone(e)); }, events: async function* () { yield* clone(entries); } };
    return { bonds, users, matches, feeds, entries, store, record: { event: 'applied', write: manifest },
        c: { bonds: bonds.collection, users: users.collection, matches: matches.collection, feeds: feeds.collection } };
}

export async function runBondReconciliationExecutionTests() {
    let passed = 0, failed = 0;
    const test = async (name: string, fn: () => Promise<void>) => { try { await fn(); passed++; } catch (e) { failed++; console.error(name, e); } };
    await test('native adapter preserves helper cache domains, owners, timestamps and deferred schedule', async () => {
        const f = fixture();
        await reconcileRepairNative(f.c, f.record, f.store, { writeWindowConfirmed: true, batchSize: 1 });
        assert.deepEqual(f.matches.data.map(d => String(d._id)), [String(oid(204))]);
        assert.deepEqual(f.feeds.data.map(d => String(d._id)), [String(oid(303))]);
        assert.deepEqual(f.bonds.data.map(d => d.matchesGen), [2, 3, 4, 4]);
        assert.ok(f.bonds.data.slice(0, 3).every(d => d.matchesNextAt.getTime() === 0 && !('matchesComputedAt' in d)));
        assert.ok(f.bonds.data.every(d => d.updatedAt.getTime() === 10));
        assert.deepEqual(f.users.data.map(d => d.hasActiveBonds), [false, true, true, true]);
        assert.ok(f.users.data.every(d => d.updatedAt.getTime() === 12));
        assert.equal((await verifyRepairReconciliation(f.c, f.record, f.store)).verified, true);
        const writes = f.bonds.count() + f.users.count() + f.matches.count() + f.feeds.count();
        await reconcileRepairNative(f.c, f.record, f.store, { writeWindowConfirmed: true });
        assert.equal(f.bonds.count() + f.users.count() + f.matches.count() + f.feeds.count(), writes);
    });
    await test('multiple repaired roots share targets safely and all manifests still verify', async () => {
        const f = fixture();
        f.bonds.data[1].isPause = true;
        const other = { event: 'applied', write: makeWriteDecision('repair', { ...f.bonds.data[1], isPause: null })!.manifest };
        await reconcileRepairNative(f.c, f.record, f.store, { writeWindowConfirmed: true });
        await reconcileRepairNative(f.c, other, f.store, { writeWindowConfirmed: true });
        assert.equal((await verifyRepairReconciliation(f.c, f.record, f.store)).verified, true);
        assert.equal((await verifyRepairReconciliation(f.c, other, f.store)).verified, true);
        assert.equal(f.users.data[1].hasActiveBonds, false);
        assert.deepEqual(f.bonds.data.map(d => d.matchesGen), [2, 4, 5, 4]);
    });
    await test('resume after deleted cache receipt loss retains discovered affected sources', async () => {
        const f = fixture(); let fail = true;
        const store = { ...f.store, append: async (e: ReconciliationEvent) => {
            if (fail && e.event === 'reconcile-effect' && e.phase === 'applied' && e.collection === 'matches') { fail = false; throw new Error('receipt unavailable'); }
            await f.store.append(e);
        } };
        await assert.rejects(reconcileRepairNative(f.c, f.record, store, { writeWindowConfirmed: true }));
        assert.ok(f.entries.some(e => e.event === 'reconcile-discovered'));
        await reconcileRepairNative(f.c, f.record, store, { writeWindowConfirmed: true });
        assert.deepEqual(f.bonds.data.map(d => d.matchesGen), [2, 3, 4, 4]);
        assert.ok(f.entries.some(e => e.event === 'reconcile-effect' && e.collection === 'matches' && e.phase === 'observed'));
        assert.equal((await verifyRepairReconciliation(f.c, f.record, store)).verified, true);
    });
    await test('resume after schedule receipt loss observes state without double increment or claimed receipt', async () => {
        const f = fixture(); let fail = true;
        const store = { ...f.store, append: async (e: ReconciliationEvent) => {
            if (fail && e.event === 'reconcile-effect' && e.phase === 'applied' && e.collection === 'bonds') { fail = false; throw new Error('receipt unavailable'); }
            await f.store.append(e);
        } };
        await assert.rejects(reconcileRepairNative(f.c, f.record, store, { writeWindowConfirmed: true }));
        await reconcileRepairNative(f.c, f.record, store, { writeWindowConfirmed: true });
        assert.equal(f.bonds.data[0].matchesGen, 2);
        assert.ok(f.entries.some(e => e.event === 'reconcile-effect' && e.collection === 'bonds' && e.phase === 'observed'));
    });
    await test('uncertain intent plus newer generation is a conflict, not overwritten or certified', async () => {
        const f = fixture(); let fail = true;
        const store = { ...f.store, append: async (e: ReconciliationEvent) => {
            await f.store.append(e);
            if (fail && e.event === 'reconcile-effect' && e.phase === 'prepared' && e.collection === 'bonds') { fail = false; f.bonds.data[0].matchesGen = 99; throw new Error('interrupted'); }
        } };
        await assert.rejects(reconcileRepairNative(f.c, f.record, store, { writeWindowConfirmed: true }));
        await assert.rejects(reconcileRepairNative(f.c, f.record, store, { writeWindowConfirmed: true }));
        assert.equal(f.bonds.data[0].matchesGen, 99);
        await assert.rejects(verifyRepairReconciliation(f.c, f.record, store));
    });
    await test('verification checks persisted cache, owner and timestamp state, not just receipts', async () => {
        const f = fixture(); await reconcileRepairNative(f.c, f.record, f.store, { writeWindowConfirmed: true });
        f.users.data[0].hasActiveBonds = true;
        await assert.rejects(verifyRepairReconciliation(f.c, f.record, f.store));
        f.users.data[0].hasActiveBonds = false; f.bonds.data[0].updatedAt = new Date(999);
        await assert.rejects(verifyRepairReconciliation(f.c, f.record, f.store));
    });
    await test('conditional rollback after reconciliation restores flags but never decreases generation', async () => {
        const f = fixture(); await reconcileRepairNative(f.c, f.record, f.store, { writeWindowConfirmed: true });
        const write = await reconciledRollbackManifest(f.record.write, f.store);
        const entries: ReconciliationEvent[] = [];
        const store: ReconciliationStore = { append: async e => { entries.push(clone(e)); }, events: async function* () { yield* clone(entries); } };
        const restored = await rollbackMaintenanceWrite(f.c.bonds, { event: 'applied', write }, async receipt => {
            if (receipt.event === 'rolled-back') await reconcileRepairNative(f.c, receipt, store, { writeWindowConfirmed: true });
        });
        assert.equal(restored, true); assert.equal(f.bonds.data[0].isPause, null);
        assert.equal(f.bonds.data[0].matchesGen, 3); assert.equal(f.bonds.data[0].updatedAt.getTime(), 10);
        assert.equal(f.users.data[0].hasActiveBonds, false);
    });
    await test('rollback does not overwrite a scheduler update newer than recorded reconciliation', async () => {
        const f = fixture(); await reconcileRepairNative(f.c, f.record, f.store, { writeWindowConfirmed: true });
        const write = await reconciledRollbackManifest(f.record.write, f.store);
        f.bonds.data[0].matchesGen = 99;
        assert.equal(await rollbackMaintenanceWrite(f.c.bonds, { event: 'applied', write }, async () => {}), false);
        assert.equal(f.bonds.data[0].isPause, true); assert.equal(f.bonds.data[0].matchesGen, 99);
    });
    await test('write-window acknowledgement and actual receipt are mandatory', async () => {
        const f = fixture();
        await assert.rejects(reconcileRepairNative(f.c, f.record, f.store, { writeWindowConfirmed: false }));
        await assert.rejects(reconcileRepairNative(f.c, { ...f.record, event: 'prepared' }, f.store, { writeWindowConfirmed: true }));
        assert.equal(f.bonds.count(), 0);
    });
    return { pass: passed, fail: failed };
}
