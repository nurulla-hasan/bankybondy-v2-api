import { isDeepStrictEqual } from 'node:util';
import type { mongo } from 'mongoose';
import { observedStateGuard, type MaintenanceCollection, type MaintenanceDocument, type WriteManifest } from './bondMaintenance';

export type ReconciliationCollections = { bonds: MaintenanceCollection; matches: MaintenanceCollection; feeds: MaintenanceCollection; users: MaintenanceCollection };
export type ReconciliationEvent =
    | { event: 'reconcile-target'; root: mongo.ObjectId; target: mongo.ObjectId; clearMatches: boolean }
    | { event: 'reconcile-discovered' | 'reconcile-complete'; root: mongo.ObjectId }
    | { event: 'reconcile-effect'; root: mongo.ObjectId; key: string; collection: keyof ReconciliationCollections;
        phase: 'prepared' | 'applied' | 'observed'; before: MaintenanceDocument; after: MaintenanceDocument | null };
export type ReconciliationStore = {
    append: (event: ReconciliationEvent) => Promise<void>;
    events: () => AsyncIterable<ReconciliationEvent>;
};
const own = (d: MaintenanceDocument, key: string) => Object.prototype.hasOwnProperty.call(d, key);
const oid = (v: unknown): v is mongo.ObjectId => !!v && typeof v === 'object' && typeof (v as mongo.ObjectId).toHexString === 'function';
const sameId = (a: unknown, b: unknown) => String(a) === String(b);
const scheduleFields = ['_id', 'user', 'status', 'isLinked', 'isPause', 'isDeleted', 'integrityRevision', 'matchesGen', 'matchesNextAt', 'matchesComputedAt', 'createdAt', 'updatedAt'];
const ownerFields = ['_id', 'hasActiveBonds', 'bondSeq', 'createdAt', 'updatedAt'];
const projection = (keys: string[]) => Object.fromEntries(keys.map(k => [k, 1]));
const writeConcern = { w: 'majority' as const };

export function planScheduleInvalidation(before: MaintenanceDocument) {
    if (own(before, 'matchesGen') && (!Number.isSafeInteger(before.matchesGen) || before.matchesGen < 0 || before.matchesGen === Number.MAX_SAFE_INTEGER)) {
        throw new Error('Malformed/overflowing generation; reconciliation blocked');
    }
    const $set = { matchesGen: (before.matchesGen ?? 0) + 1, matchesNextAt: new Date(0) };
    const after: MaintenanceDocument = { ...before, ...$set }; delete after.matchesComputedAt;
    return { filter: observedStateGuard(before, scheduleFields), update: { $set, $unset: { matchesComputedAt: '' } }, after };
}
export function planOwnerFlag(before: MaintenanceDocument, active: boolean) {
    const after: MaintenanceDocument = { ...before, hasActiveBonds: active };
    return { filter: observedStateGuard(before, ownerFields), update: { $set: { hasActiveBonds: active } }, after };
}
export function reconciliationScheduleSatisfied(current: MaintenanceDocument | null, expected: MaintenanceDocument) {
    return !!current && Number.isSafeInteger(current.matchesGen) && current.matchesGen >= expected.matchesGen
        && current.matchesNextAt instanceof Date && current.matchesNextAt.getTime() === 0 && !own(current, 'matchesComputedAt')
        && isDeepStrictEqual(current.createdAt, expected.createdAt) && isDeepStrictEqual(current.updatedAt, expected.updatedAt);
}

async function latest(store: ReconciliationStore, root: mongo.ObjectId, key?: string, event?: ReconciliationEvent['event']) {
    let found: ReconciliationEvent | undefined;
    for await (const e of store.events()) {
        if (sameId(e.root, root) && (key ? e.event === 'reconcile-effect' && e.key === key : e.event === event)) found = e;
    }
    return found;
}
async function hasActiveBond(c: ReconciliationCollections, user: mongo.ObjectId) {
    // Same domain as FILTRO_VINCULO_VIVO: ONGOING counts, missing isLinked counts, missing pause does not.
    return !!await c.bonds.findOne({ user, status: { $in: ['WAITING_FOR_LINK', 'ONGOING'] }, isPause: false, isLinked: { $ne: true } }, { projection: { _id: 1 } });
}

/** A recovered post-state is recorded as observed, NEVER as an acknowledged tool write eligible for rollback. */
async function effect(c: ReconciliationCollections, store: ReconciliationStore,
    proposed: Extract<ReconciliationEvent, { event: 'reconcile-effect' }>) {
    const previous = await latest(store, proposed.root, proposed.key);
    const intent = previous?.event === 'reconcile-effect' ? previous : proposed;
    if (previous?.event === 'reconcile-effect' && previous.phase !== 'prepared') return;
    if (!previous) await store.append(intent);
    const collection = c[intent.collection];
    const fields = intent.collection === 'bonds' ? scheduleFields : ownerFields;
    const current = await collection.findOne({ _id: intent.before._id }, intent.after ? { projection: projection(fields) } : {});
    if ((!current && intent.after === null) || (intent.after && current && isDeepStrictEqual(current, intent.after))) {
        await store.append({ ...intent, phase: 'observed' }); return;
    }
    if (!current || !isDeepStrictEqual(current, intent.before)) throw new Error('Reconciliation CAS conflict; newer state was not overwritten');
    if (intent.after === null) {
        const result = await collection.deleteOne({ _id: current._id, $expr: { $eq: ['$$ROOT', { $literal: current }] } }, { writeConcern });
        if (!result.acknowledged || result.deletedCount !== 1) throw new Error('Cache changed during conditional invalidation');
    } else {
        const decision = intent.collection === 'bonds' ? planScheduleInvalidation(intent.before) : planOwnerFlag(intent.before, intent.after.hasActiveBonds);
        const result = await collection.updateOne(decision.filter, decision.update, { writeConcern });
        if (!result.acknowledged || result.matchedCount !== 1 || result.modifiedCount !== 1) throw new Error('Reconciliation conditional update failed');
    }
    await store.append({ ...intent, phase: 'applied' });
}

async function clearCache(c: ReconciliationCollections, store: ReconciliationStore, root: mongo.ObjectId,
    collection: 'matches' | 'feeds', filter: MaintenanceDocument, batchSize: number) {
    const cursor = c[collection].find(filter).batchSize(batchSize);
    try {
        for await (const before of cursor) {
            await effect(c, store, { event: 'reconcile-effect', root, key: `${collection}:${before._id}`, collection, phase: 'prepared', before, after: null });
        }
    } finally { await cursor.close(); }
    // A crashed delete may no longer appear in the query; resolve its persisted intent explicitly.
    for await (const e of store.events()) if (e.event === 'reconcile-effect' && sameId(e.root, root) && e.collection === collection && e.phase === 'prepared') await effect(c, store, e);
}
async function reconcileOwner(c: ReconciliationCollections, store: ReconciliationStore, root: mongo.ObjectId, user: mongo.ObjectId) {
    if (!oid(user)) throw new Error('Invalid affected owner');
    const before = await c.users.findOne({ _id: user }, { projection: projection(ownerFields) });
    if (!before) throw new Error('Affected owner is missing');
    const active = await hasActiveBond(c, user);
    const plan = planOwnerFlag(before, active);
    await effect(c, store, { event: 'reconcile-effect', root, key: `owner:${user}`, collection: 'users', phase: 'prepared', before, after: plan.after });
}

/** Call under the same quiesced writer/worker window as repair. All handles are explicit; no models/config/queues.
 * Journal scans trade disk reads for bounded heap. Discovery is durably finished BEFORE deleting any cache.
 * Invalidated active bonds remain epoch-due for the ordinary sweep; no scores/sealing or timestamps are changed.
 */
export async function reconcileRepairNative(c: ReconciliationCollections, record: { event: string; write?: WriteManifest }, store: ReconciliationStore,
    options: { writeWindowConfirmed: boolean; batchSize?: number }) {
    if (!options.writeWindowConfirmed || !['applied', 'rolled-back'].includes(record.event) || record.write?.kind !== 'repair') throw new Error('Requires actual repair/rollback record and quiesced write window');
    const write = record.write, root = write.id, batchSize = options.batchSize ?? 100;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('Invalid reconciliation batchSize');
    if (!(await latest(store, root, undefined, 'reconcile-discovered'))) {
        await store.append({ event: 'reconcile-target', root, target: root, clearMatches: true });
        for (const [name, field] of [['matches', 'sourceBond'], ['feeds', 'bond']] as const) {
            const cursor = c[name].find({ bonds: root }, { projection: { [field]: 1 } }).batchSize(batchSize);
            try {
                for await (const row of cursor) {
                    if (!oid(row[field])) throw new Error('Invalid affected cache bond reference');
                    await store.append({ event: 'reconcile-target', root, target: row[field], clearMatches: name === 'matches' });
                }
            } finally { await cursor.close(); }
        }
        await store.append({ event: 'reconcile-discovered', root });
    }
    for await (const target of store.events()) {
        if (target.event !== 'reconcile-target' || !sameId(target.root, root)) continue;
        const before = await c.bonds.findOne({ _id: target.target }, { projection: projection(scheduleFields) });
        if (!before) throw new Error('Affected bond missing; resolve history before reconciliation');
        const key = `schedule:${target.target}`;
        const previous = await latest(store, root, key);
        if (!previous) {
            const plan = planScheduleInvalidation(before);
            await effect(c, store, { event: 'reconcile-effect', root, key, collection: 'bonds', phase: 'prepared', before, after: plan.after });
        } else if (previous.event === 'reconcile-effect') await effect(c, store, previous);
        if (target.clearMatches) await clearCache(c, store, root, 'matches', { sourceBond: target.target }, batchSize);
        await reconcileOwner(c, store, root, before.user);
    }
    await clearCache(c, store, root, 'feeds', { bonds: root }, batchSize);
    await reconcileOwner(c, store, root, write.user);
    await verifyRepairReconciliation(c, record, store, false);
    if (!(await latest(store, root, undefined, 'reconcile-complete'))) await store.append({ event: 'reconcile-complete', root });
}

/** Roll back business flags, not monotonic invalidation generations or deleted derived caches. The normal
 * rollback CAS still checks original text digest/revision/timestamps plus the recorded reconciliation schedule. */
export async function reconciledRollbackManifest(write: WriteManifest, store: ReconciliationStore): Promise<WriteManifest> {
    let schedule: Extract<ReconciliationEvent, { event: 'reconcile-effect' }> | undefined;
    for await (const e of store.events()) {
        if (e.event === 'reconcile-effect' && e.collection === 'bonds' && sameId(e.before._id, write.id)
            && e.phase !== 'prepared' && e.after && (!schedule || e.after.matchesGen >= schedule.after!.matchesGen)) schedule = e;
    }
    if (!schedule) return write;
    const after = { ...write.after };
    for (const key of ['matchesGen', 'matchesNextAt', 'matchesComputedAt']) {
        if (own(schedule.after!, key)) after[key] = schedule.after![key]; else delete after[key];
    }
    return { ...write, after, changed: write.changed.filter(f => f !== 'matchesGen' && f !== 'matchesNextAt') };
}

export async function verifyRepairReconciliation(c: ReconciliationCollections, record: { event: string; write?: WriteManifest }, store: ReconciliationStore, requireComplete = true) {
    if (!['applied', 'rolled-back'].includes(record.event) || record.write?.kind !== 'repair') throw new Error('Verification requires an actual repair/rollback record');
    const root = record.write.id;
    if (!(await latest(store, root, undefined, 'reconcile-discovered')) || (requireComplete && !(await latest(store, root, undefined, 'reconcile-complete')))) throw new Error('Reconciliation discovery/completion not recorded');
    for await (const entry of store.events()) {
        if (!sameId(entry.root, root)) continue;
        if (entry.event === 'reconcile-target') {
            const schedule = await latest(store, root, `schedule:${entry.target}`);
            if (schedule?.event !== 'reconcile-effect' || schedule.phase === 'prepared' || !schedule.after) throw new Error('Affected schedule is unverified');
            const current = await c.bonds.findOne({ _id: entry.target }, { projection: projection(scheduleFields) });
            if (!reconciliationScheduleSatisfied(current, schedule.after)) throw new Error('Affected schedule/timestamps failed verification');
            if (entry.clearMatches && await c.matches.findOne({ sourceBond: entry.target }, { projection: { _id: 1 } })) throw new Error('Affected match cache remains');
            const owner = current && await c.users.findOne({ _id: current.user }, { projection: projection(ownerFields) });
            if (!owner || owner.hasActiveBonds !== await hasActiveBond(c, current!.user)) throw new Error('Affected owner flag is inconsistent');
        }
        if (entry.event === 'reconcile-effect') {
            const last = await latest(store, root, entry.key);
            if (last?.event !== 'reconcile-effect' || last.phase === 'prepared') throw new Error('Unresolved reconciliation intent');
            if (entry.collection === 'users' && entry.after) {
                const owner = await c.users.findOne({ _id: entry.before._id }, { projection: projection(ownerFields) });
                if (!owner || owner.hasActiveBonds !== await hasActiveBond(c, owner._id)
                    || !isDeepStrictEqual(owner.createdAt, entry.before.createdAt) || !isDeepStrictEqual(owner.updatedAt, entry.before.updatedAt)) throw new Error('Owner bookkeeping/timestamps failed verification');
            }
        }
    }
    if (await c.feeds.findOne({ bonds: root }, { projection: { _id: 1 } })) throw new Error('Affected feed cache remains');
    return { verified: true as const, root };
}
