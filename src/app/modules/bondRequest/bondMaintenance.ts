import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { mongo } from 'mongoose';
import type { ReconciliationEvent } from './bondMaintenance.reconcile';
import { canonicalBondText, BOND_IDENTITY_INDEX } from './bondIdentity';
import { ENUM_BOND_REQUEST_STATUS } from './bondRequest.enum';

export type MaintenanceDocument = mongo.Document;
export type MaintenanceKind = 'repair' | 'identity';
export type MaintenanceCollection = mongo.Collection<MaintenanceDocument>;
type Projection = { issues: string[]; set: MaintenanceDocument };
const WAITING = ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK;
const has = (d: MaintenanceDocument, key: string) => Object.prototype.hasOwnProperty.call(d, key);
const objectId = (v: unknown): boolean => !!v && typeof v === 'object'
    && (v as mongo.ObjectId)._bsontype === 'ObjectId'
    && typeof (v as mongo.ObjectId).toHexString === 'function'
    && /^[0-9a-f]{24}$/.test((v as mongo.ObjectId).toHexString());
const fields = ['_id', 'user', 'status', 'isDeleted', 'isPause', 'isLinked', 'offer', 'want', 'offerKey', 'wantKey',
    'matchesGen', 'matchesNextAt', 'matchesComputedAt', 'createdAt', 'updatedAt', 'integrityRevision'];
export const MAINTENANCE_PROJECTION = Object.fromEntries(fields.map(f => [f, 1]));

function stateIssues(d: MaintenanceDocument): string[] {
    const issues: string[] = [];
    if (!objectId(d._id)) issues.push('non-ObjectId _id cannot be resumed safely');
    if (!objectId(d.user)) issues.push('invalid user');
    if (!Object.values(ENUM_BOND_REQUEST_STATUS).includes(d.status)) issues.push('invalid status');
    for (const f of ['isDeleted', 'isPause', 'isLinked']) {
        if (has(d, f) && typeof d[f] !== 'boolean' && !(f === 'isPause' && d[f] === null)) issues.push(`invalid ${f}`);
    }
    if (d.isDeleted === true && (d.isLinked !== true || d.isPause !== true)) issues.push('inconsistent deleted eligibility');
    if (has(d, 'matchesGen') && (!Number.isSafeInteger(d.matchesGen) || d.matchesGen < 0)) issues.push('invalid matchesGen');
    if (has(d, 'matchesNextAt') && (!(d.matchesNextAt instanceof Date) || !Number.isFinite(d.matchesNextAt.getTime()))) issues.push('invalid matchesNextAt');
    return issues;
}

export function projectLegacyRepair(d: MaintenanceDocument): Projection {
    const issues = stateIssues(d);
    const set: MaintenanceDocument = {};
    if (issues.length) return { issues, set };
    if (d.isPause === null) set.isPause = true;
    if (!has(d, 'isLinked') && d.isDeleted !== true) {
        set.isLinked = false;
        if (d.status === WAITING && d.isPause === false) {
            if (!has(d, 'matchesGen')) set.matchesGen = 0;
            if (!has(d, 'matchesNextAt')) set.matchesNextAt = new Date(0);
        }
    }
    return { issues, set };
}

export function projectIdentityBackfill(d: MaintenanceDocument): Projection {
    const repair = projectLegacyRepair(d);
    const issues = [...repair.issues];
    if (Object.keys(repair.set).length) issues.push('legacy repair required');
    for (const f of ['offer', 'want']) if (typeof d[f] !== 'string' || !d[f].trim()) issues.push(`invalid ${f}`);
    const set: MaintenanceDocument = {};
    if (!issues.length) for (const f of ['offer', 'want']) {
        const key = `${f}Key`, value = canonicalBondText(d[f]);
        if (d[key] !== value) set[key] = value;
    }
    return { issues, set };
}

/** $expr compares the scalar BSON value; ordinary equality can match array elements. */
export function observedStateGuard(d: MaintenanceDocument, observedFields: readonly string[] = fields): mongo.Filter<MaintenanceDocument> {
    return { _id: d._id, $and: observedFields.filter(f => f !== '_id').map(f => {
        if (!has(d, f)) return { [f]: { $exists: false } };
        const v = d[f];
        const type = v === null ? 'null' : v instanceof Date ? 'date' : objectId(v) ? 'objectId'
            : Array.isArray(v) ? 'array' : typeof v === 'boolean' ? 'bool' : typeof v;
        const typeCheck = type === 'number'
            ? { $in: [{ $type: `$${f}` }, ['int', 'long', 'double', 'decimal']] }
            : { $eq: [{ $type: `$${f}` }, type] };
        return { [f]: v === null ? { $type: 'null' } : { $exists: true },
            $expr: { $and: [typeCheck, { $eq: [`$${f}`, { $literal: v }] }] } };
    }) };
}

function snapshot(d: MaintenanceDocument): MaintenanceDocument {
    const result = Object.fromEntries(fields.filter(f => has(d, f) && f !== 'offer' && f !== 'want').map(f => [f, d[f]]));
    // Raw public text is never persisted; digests also catch equivalent-text edits.
    result.textDigest = createHash('sha256').update(JSON.stringify([d.offer, d.want])).digest('hex');
    return result;
}
export type WriteManifest = {
    kind: MaintenanceKind;
    id: mongo.ObjectId;
    user: mongo.ObjectId;
    before: MaintenanceDocument;
    after: MaintenanceDocument;
    changed: string[];
};
export function makeWriteDecision(kind: MaintenanceKind, d: MaintenanceDocument) {
    const p = kind === 'repair' ? projectLegacyRepair(d) : projectIdentityBackfill(d);
    if (p.issues.length) throw new Error(`Blocked document ${String(d._id)}: ${p.issues.join(', ')}`);
    const changed = Object.keys(p.set);
    if (!changed.length) return null;
    return { filter: observedStateGuard(d), update: { $set: p.set }, manifest: {
        kind, id: d._id, user: d.user, before: snapshot(d), after: snapshot({ ...d, ...p.set }), changed,
    } satisfies WriteManifest };
}

export function makeRollbackDecision(entry: WriteManifest, current: MaintenanceDocument) {
    if (!isDeepStrictEqual(snapshot(current), entry.after)) return null;
    const $set: MaintenanceDocument = {}, $unset: MaintenanceDocument = {};
    for (const f of entry.changed) {
        if (has(entry.before, f)) $set[f] = entry.before[f]; else $unset[f] = '';
    }
    return { filter: observedStateGuard(current), update: {
        ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}),
    } };
}

export type MaintenanceReport = {
    scanned: number; invalid: number; collisions: number; pendingRepairs: number; pendingKeys: number; complete: boolean;
    samples: Array<{ id: string; issue: string; otherId?: string }>;
};
export type JournalEvent = ReconciliationEvent
    | { event: 'prepared' | 'applied' | 'conflict' | 'rollback-prepared' | 'rolled-back' | 'rollback-conflict' | 'reconciled'; write: WriteManifest }
    | { event: 'checkpoint'; after: mongo.ObjectId | null; scanned: number; applied: number; exhausted: boolean }
    | { event: 'index-prepared' | 'index-created'; name: string }
    | { event: 'preflight'; report: MaintenanceReport };
export type MaintenanceJournal = (entry: JournalEvent) => Promise<void>;
const batch = (value = 100) => {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error('batchSize must be 1..1000');
    return value;
};

/** One projected cursor, grouped by user. A cap produces a blocking incomplete
 * report, never truncation or a clean preflight. */
export async function preflightMaintenance(collection: MaintenanceCollection, batchSize = 100, identityCap = 10000): Promise<MaintenanceReport> {
    batch(batchSize);
    if (!Number.isSafeInteger(identityCap) || identityCap < 1 || identityCap > 10000) throw new Error('identityCap must be 1..10000');
    const report: MaintenanceReport = { scanned: 0, invalid: 0, collisions: 0, pendingRepairs: 0, pendingKeys: 0, complete: true, samples: [] };
    const identities = new Map<string, { id: mongo.ObjectId; count: number }>();
    let owner: string | undefined, identityBytes = 0;
    const issue = (id: unknown, message: string, otherId?: unknown) => {
        if (report.samples.length < 50) report.samples.push({ id: objectId(id) ? String(id) : '<invalid ObjectId>',
            issue: message, ...(otherId ? { otherId: objectId(otherId) ? String(otherId) : '<invalid ObjectId>' } : {}) });
    };
    const cursor = collection.find({}, { projection: MAINTENANCE_PROJECTION }).sort({ user: 1, _id: 1 }).allowDiskUse(true).batchSize(batchSize);
    try {
        for await (const d of cursor) {
            report.scanned++;
            const repair = projectLegacyRepair(d);
            const textValid = typeof d.offer === 'string' && !!d.offer.trim() && typeof d.want === 'string' && !!d.want.trim();
            const invalid = [...repair.issues, ...(!textValid ? ['invalid identity text'] : [])];
            if (invalid.length) { report.invalid++; issue(d._id, invalid.join(', ')); }
            if (Object.keys(repair.set).length) report.pendingRepairs++;
            if (textValid && (d.offerKey !== canonicalBondText(d.offer) || d.wantKey !== canonicalBondText(d.want))) report.pendingKeys++;
            // Preflight includes missing/null isLinked, before the equality repair.
            if (d.status !== WAITING || d.isLinked === true || !textValid || !objectId(d.user) || !objectId(d._id)) continue;
            if (owner !== String(d.user)) { identities.clear(); identityBytes = 0; owner = String(d.user); }
            const key = JSON.stringify([canonicalBondText(d.offer), canonicalBondText(d.want)]);
            const previous = identities.get(key);
            if (previous) {
                report.collisions += previous.count++;
                issue(d._id, 'canonical identity collision', previous.id);
            } else {
                const bytes = Buffer.byteLength(key, 'utf8');
                if (identities.size >= identityCap || identityBytes + bytes > 64 * 1024 * 1024) {
                    report.invalid++; report.complete = false;
                    issue(d._id, 'per-user identity map cap exceeded; preflight incomplete, no writes permitted');
                    break;
                }
                identities.set(key, { id: d._id, count: 1 }); identityBytes += bytes;
            }
        }
    } finally { await cursor.close(); }
    return report;
}

export class MaintenanceBlockedError extends Error {
    constructor(public readonly report: MaintenanceReport) {
        super('Maintenance blocked; inspect bounded report samples and resolve states/collisions manually');
    }
}
function assertPreflight(report: MaintenanceReport, kind: MaintenanceKind, requireCoverage = false) {
    if (!report.complete || report.invalid || report.collisions || (kind === 'identity' && report.pendingRepairs)
        || (requireCoverage && report.pendingKeys)) throw new MaintenanceBlockedError(report);
}

export async function readIdentityIndex(collection: MaintenanceCollection) {
    let indexes: MaintenanceDocument[];
    try { indexes = await collection.listIndexes().toArray(); }
    catch (error) {
        if ((error as { code?: number }).code === 26) return undefined;
        throw error;
    }
    const existing = indexes.find(i => i.name === BOND_IDENTITY_INDEX.name);
    if (existing && !indexMatchesSpecification(existing)) throw new Error('Incompatible existing named identity index; never replaced automatically');
    return existing;
}

export async function applyMaintenanceBatch(collection: MaintenanceCollection, kind: MaintenanceKind, options: {
    journal: MaintenanceJournal; batchSize?: number; after?: mongo.ObjectId; maxDocuments?: number; writeWindowConfirmed: boolean;
}) {
    if (!options.writeWindowConfirmed) throw new Error('An operator-controlled write window is required');
    const size = batch(options.batchSize);
    const limit = options.maxDocuments ?? 500;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('maxDocuments must be 1..10000');
    if (options.after && !objectId(options.after)) throw new Error('after must be an ObjectId');
    const report = await preflightMaintenance(collection, size);
    await options.journal({ event: 'preflight', report });
    assertPreflight(report, kind);
    if (kind === 'identity') await readIdentityIndex(collection);
    let after = options.after ?? null, scanned = 0, applied = 0, conflict = false;
    const cursor = collection.find(after ? { _id: { $gt: after } } : {}, { projection: MAINTENANCE_PROJECTION })
        .sort({ _id: 1 }).limit(limit).batchSize(size);
    try {
        for await (const d of cursor) {
            scanned++;
            const decision = makeWriteDecision(kind, d);
            if (decision) {
                await options.journal({ event: 'prepared', write: decision.manifest });
                // Native collections bypass Mongoose timestamps/defaults/hooks.
                const result = await collection.updateOne(decision.filter, decision.update, { writeConcern: { w: 'majority' } });
                if (!result.acknowledged || result.matchedCount !== 1 || result.modifiedCount !== 1) {
                    conflict = true;
                    await options.journal({ event: 'conflict', write: decision.manifest });
                    break;
                }
                applied++;
                await options.journal({ event: 'applied', write: decision.manifest });
            }
            after = d._id;
        }
    } finally { await cursor.close(); }
    const exhausted = !conflict && scanned < limit;
    await options.journal({ event: 'checkpoint', after, scanned, applied, exhausted });
    return { after, scanned, applied, exhausted, conflict };
}

export async function verifyMaintenance(collection: MaintenanceCollection, kind: MaintenanceKind, batchSize = 100) {
    const report = await preflightMaintenance(collection, batchSize);
    assertPreflight(report, kind, kind === 'identity');
    if (report.pendingRepairs) throw new MaintenanceBlockedError(report);
    if (kind === 'identity' && !(await readIdentityIndex(collection))) throw new Error('Migration-owned identity index is absent');
    return report;
}

export async function installIdentityIndex(collection: MaintenanceCollection, options: {
    journal: MaintenanceJournal; writeWindowConfirmed: boolean; batchSize?: number;
}) {
    if (!options.writeWindowConfirmed) throw new Error('Drain upgraded writers before index cutover');
    const report = await preflightMaintenance(collection, batch(options.batchSize));
    await options.journal({ event: 'preflight', report });
    assertPreflight(report, 'identity', true);
    if (!(await readIdentityIndex(collection))) {
        await options.journal({ event: 'index-prepared', name: BOND_IDENTITY_INDEX.name });
        await collection.createIndex(BOND_IDENTITY_INDEX.key, { ...BOND_IDENTITY_INDEX.options, name: BOND_IDENTITY_INDEX.name });
        await options.journal({ event: 'index-created', name: BOND_IDENTITY_INDEX.name });
    }
    return verifyMaintenance(collection, 'identity', options.batchSize);
}

/** Accept only a durable applied record, never baseline/prepared. Newer values
 * cause a skip, not a restore. */
export async function rollbackMaintenanceWrite(collection: MaintenanceCollection, record: JournalEvent, journal: MaintenanceJournal) {
    if (record.event !== 'applied') throw new Error('Rollback requires an acknowledged applied record');
    const entry = record.write;
    if (entry.kind === 'identity' && await readIdentityIndex(collection)) {
        throw new Error('Identity rollback requires a separately approved index removal and writer rollback first');
    }
    const current = await collection.findOne({ _id: entry.id }, { projection: MAINTENANCE_PROJECTION });
    const decision = current && makeRollbackDecision(entry, current);
    if (decision) await journal({ event: 'rollback-prepared', write: entry });
    const result = decision && await collection.updateOne(decision.filter, decision.update, { writeConcern: { w: 'majority' } });
    const restored = !!result && result.acknowledged && result.modifiedCount === 1;
    await journal({ event: restored ? 'rolled-back' : 'rollback-conflict', write: entry });
    return restored;
}

/** The caller injects throwing/verified wrappers for existing invalidation and
 * active-bond helpers; maintenance code imports no config, clients or workers. */
export async function reconcileMaintenanceWrite(collection: MaintenanceCollection, record: JournalEvent, hooks: {
    invalidateAndRefresh: (id: string, active: boolean) => Promise<void>;
    recalculateActiveBonds: (user: string) => Promise<void>;
    verify: (entry: WriteManifest) => Promise<boolean>;
}, journal: MaintenanceJournal) {
    if (record.event !== 'applied' || record.write.kind !== 'repair') throw new Error('Reconciliation requires an actual repair write');
    const current = await collection.findOne({ _id: record.write.id }, { projection: MAINTENANCE_PROJECTION });
    const active = !!current && current.status === WAITING && current.isLinked === false && current.isPause === false && current.isDeleted !== true;
    await hooks.invalidateAndRefresh(String(record.write.id), active);
    await hooks.recalculateActiveBonds(String(record.write.user));
    if (!(await hooks.verify(record.write))) throw new Error('Reconciliation did not pass explicit persisted-state verification');
    const after = await collection.findOne({ _id: record.write.id }, { projection: MAINTENANCE_PROJECTION });
    if (current && after && (!isDeepStrictEqual(current.createdAt, after.createdAt) || !isDeepStrictEqual(current.updatedAt, after.updatedAt))) {
        throw new Error('Reconciliation changed recorded timestamps; no successful reconciliation recorded');
    }
    await journal({ event: 'reconciled', write: record.write });
}

export function indexMatchesSpecification(index: MaintenanceDocument): boolean {
    const spec = BOND_IDENTITY_INDEX;
    return index.name === spec.name && isDeepStrictEqual(Object.entries(index.key ?? {}), Object.entries(spec.key))
        && index.unique === true && index.sparse !== true && index.hidden !== true
        && !has(index, 'expireAfterSeconds')
        // Mongo may omit collation metadata for the simple/binary collation.
        && (index.collation === undefined || isDeepStrictEqual(index.collation, spec.options.collation))
        && isDeepStrictEqual(index.partialFilterExpression, spec.options.partialFilterExpression);
}
