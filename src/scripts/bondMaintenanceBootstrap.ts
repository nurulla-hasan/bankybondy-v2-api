import { createReadStream, closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import mongoose from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import { reconcileRepairNative, verifyRepairReconciliation, reconciledRollbackManifest,
    type ReconciliationCollections, type ReconciliationEvent, type ReconciliationStore,
} from '../app/modules/bondRequest/bondMaintenance.reconcile';
import {
    applyMaintenanceBatch, installIdentityIndex, preflightMaintenance, rollbackMaintenanceWrite,
    verifyMaintenance, MaintenanceBlockedError,
    type MaintenanceKind, type WriteManifest, type MaintenanceJournal,
} from '../app/modules/bondRequest/bondMaintenance';

const EJSON = mongoose.mongo.BSON.EJSON;
const USAGE = `Modes: dry-run | apply | reconcile | verify | rollback
Required: BONDS_MAINTENANCE_DATABASE_URL (explicit URI with database), --collection NAME
Writes: --confirm-db NAME --write-window-confirmed --manifest NEW_FILE
Batch: --batch-size 100 --max-documents 500 [--after OBJECT_ID]
Identity apply: --create-index (only after full coverage; upgraded writers must be drained)
Rollback: --rollback-from PRIOR_MANIFEST (only acknowledged actual writes; conflicts are skipped)
No .env, application config, schema, worker or automatic index/collection creation is loaded.
Before any upgraded boot backfill runs, capture a consistent backup and separate pre-deploy dry-run baseline.
After deployment/draining old writers, repeat dry-run; actual apply manifests contain ONLY this tool's writes, never boot changes.
Keep baseline and actual-write manifests distinct and access-restricted: they include canonical keys, not raw public text.
Preflight uses one user/_id-sorted cursor; >10000 unique identities or >64 MiB keys for one user blocks as incomplete (no writes).
Resume with the checkpoint --after and a NEW manifest; every invocation repeats full preflight.
An unresolved prepared record is NOT proof of a write: preserve it for manual reconciliation.
Repair apply automatically reconciles caches/schedules/owners; keep API, writers AND matching workers quiesced.
Repair apply/reconcile/verify/rollback additionally require --matches-collection NAME --feeds-collection NAME --users-collection NAME.
Repair rollback restores guarded business flags and reconciles again; it never lowers generation or restores stale derived caches.
Repair reconcile resumes --manifest EXISTING_FILE; repair verify reads --reconcile-from FILE and checks persisted invariants.
For multiple repair batches, verify EACH manifest before resuming writers. Cache rebuilds are deferred to the ordinary due sweep.
Reconciliation never enqueues jobs, seals matches, changes scoring or modifies bond/user timestamps.
Identity rollback never drops indexes: index removal/writer rollback require separate operator approval.`;

export function parseMaintenanceArguments(argv: string[], kind: MaintenanceKind) {
    if (argv.includes('--help')) return { help: true } as const;
    const mode = argv[0];
    if (!['dry-run', 'apply', 'reconcile', 'verify', 'rollback'].includes(mode)) throw new Error('Specify a maintenance mode; use --help');
    if (mode === 'reconcile' && kind !== 'repair') throw new Error('Reconcile is repair-only');
    const values: Record<string, string> = {};
    const switches = new Set(['--write-window-confirmed', '--create-index']);
    const allowed = new Set(['--collection', '--confirm-db', '--manifest', '--batch-size', '--max-documents', '--after', '--rollback-from',
        '--matches-collection', '--feeds-collection', '--users-collection', '--reconcile-from', ...switches]);
    for (let i = 1; i < argv.length; i++) {
        const key = argv[i];
        if (!allowed.has(key) || key in values) throw new Error('Unknown or repeated maintenance argument');
        if (switches.has(key)) values[key] = 'true';
        else {
            const value = argv[++i];
            if (!value || value.startsWith('--')) throw new Error('Missing maintenance argument value');
            values[key] = value;
        }
    }
    const collection = values['--collection'];
    if (!collection || !/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(collection) || collection.startsWith('system.')) throw new Error('Specify an explicit non-system --collection');
    const companions = { matches: values['--matches-collection'], feeds: values['--feeds-collection'], users: values['--users-collection'] };
    if (kind === 'repair' && ['apply', 'reconcile', 'verify', 'rollback'].includes(mode)) {
        for (const name of Object.values(companions)) {
            if (!name || !/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(name) || name.startsWith('system.')) throw new Error('Repair requires three explicit non-system companion collections');
        }
        if (new Set([collection, ...Object.values(companions)]).size !== 4) throw new Error('Repair collection handles must be distinct');
        if (mode === 'verify' && !values['--reconcile-from']) throw new Error('Repair verification requires its actual apply/reconciliation manifest');
    }
    const writing = mode === 'apply' || mode === 'rollback' || mode === 'reconcile';
    if (writing && (!values['--manifest'] || !values['--confirm-db'] || !values['--write-window-confirmed'])) throw new Error('Writes require --manifest, --confirm-db and --write-window-confirmed');
    if (values['--create-index'] && (kind !== 'identity' || mode !== 'apply')) throw new Error('--create-index is identity apply only');
    if (mode === 'rollback' && !values['--rollback-from']) throw new Error('Rollback requires --rollback-from');
    if (values['--after'] && !/^[0-9a-fA-F]{24}$/.test(values['--after'])) throw new Error('--after must be a 24-character ObjectId');
    for (const [name, maximum] of [['--batch-size', 1000], ['--max-documents', 10000]] as const) {
        if (values[name] !== undefined && (!/^\d+$/.test(values[name]) || +values[name] < 1 || +values[name] > maximum)) throw new Error(`Invalid ${name}`);
    }
    return { help: false, mode, collection, companions, writing, values } as const;
}

export function maintenanceDatabaseName(uri: string | undefined): string {
    if (!uri) throw new Error('BONDS_MAINTENANCE_DATABASE_URL is required; no application/default fallback');
    const match = /^mongodb(?:\+srv)?:\/\/[^/?#]+\/([^/?#]+)(?:\?[^#]*)?$/.exec(uri);
    if (!match) throw new Error('Maintenance URI must explicitly name a database');
    let name: string;
    try { name = decodeURIComponent(match[1]); } catch { throw new Error('Invalid encoded database name'); }
    if (!/^[A-Za-z0-9_-]+$/.test(name) || ['admin', 'local', 'config'].includes(name.toLowerCase())) throw new Error('Refusing invalid or system maintenance database');
    // Mongoose receives dbName explicitly below, so query-string options cannot override the approved target.
    return name;
}

/** Append + fsync before/after each write. Exclusive creation prevents replacing the pre-deploy baseline. */
type JournalHeader = { database: string; collection: string; kind: MaintenanceKind; companions?: { matches: string; feeds: string; users: string } };
export function openMaintenanceJournal(path: string, header: JournalHeader, resume = false) {
    const fd = openSync(resolve(path), resume ? 'a' : 'wx', 0o600);
    const append = (entry: unknown) => {
        const bytes = Buffer.from(EJSON.stringify(entry, { relaxed: false }) + '\n');
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
        fsyncSync(fd);
    };
    try {
        if (resume) { writeSync(fd, '\n'); fsyncSync(fd); }
        else append({ event: 'header', format: 1, runId: randomUUID(), ...header });
    }
    catch (error) { closeSync(fd); throw error; }
    return { journal: (async entry => append(entry)) as MaintenanceJournal, close: () => closeSync(fd) };
}

async function* readJournal(path: string) {
    const stream = createReadStream(resolve(path), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try { for await (const line of lines) if (line.trim()) yield EJSON.parse(line, { relaxed: true }); }
    finally { lines.close(); stream.destroy(); }
}

export async function* readRepairManifest(path: string, expected: JournalHeader) {
    let header = false;
    let prepared: WriteManifest | undefined;
    for await (const entry of readJournal(path)) {
        if (!header) {
            if (entry.event !== 'header' || entry.format !== 1 || entry.database !== expected.database
                || entry.collection !== expected.collection || entry.kind !== 'repair' || !isDeepStrictEqual(entry.companions, expected.companions)) {
                throw new Error('Repair manifest target or companion collections differ');
            }
            header = true; continue;
        }
        if (entry.event === 'prepared' || entry.event === 'rollback-prepared') {
            if (prepared) throw new Error('Unresolved repair intent');
            prepared = entry.write;
        }
        if (entry.event === 'applied' || entry.event === 'conflict' || entry.event === 'rolled-back' || (entry.event === 'rollback-conflict' && prepared)) {
            if (!prepared || !isDeepStrictEqual(prepared, entry.write)) throw new Error('Repair receipt lacks matching durable intent');
            prepared = undefined;
            if (entry.event === 'applied' || entry.event === 'rolled-back') yield entry as { event: 'applied' | 'rolled-back'; write: WriteManifest };
        }
    }
    if (!header || prepared) throw new Error('Missing header or unacknowledged repair intent: manual reconciliation required');
}
function reconciliationStore(path: string, append: ReconciliationStore['append']): ReconciliationStore {
    return { append, events: async function* () {
        for await (const entry of readJournal(path)) if (typeof entry.event === 'string' && entry.event.startsWith('reconcile-')) yield entry as ReconciliationEvent;
    } };
}

export async function runBondMaintenance(kind: MaintenanceKind, argv = process.argv.slice(2)) {
    const args = parseMaintenanceArguments(argv, kind);
    if (args.help === true) { console.log(USAGE); return; }
    const uri = process.env.BONDS_MAINTENANCE_DATABASE_URL;
    const database = maintenanceDatabaseName(uri);
    if (args.writing && args.values['--confirm-db'] !== database) throw new Error('--confirm-db must exactly match the explicit URI database');
    const connection = mongoose.createConnection(uri!, {
        dbName: database, autoIndex: false, autoCreate: false,
        readPreference: 'primary', readConcern: { level: 'majority' },
        serverSelectionTimeoutMS: 10000, maxPoolSize: 2,
    });
    let journalFile: ReturnType<typeof openMaintenanceJournal> | undefined;
    try {
        await connection.asPromise();
        if (!connection.db || connection.db.databaseName !== database) throw new Error('Connected database does not match approved target');
        // Selecting a handle is explicit, and no collection is created for a typo or an empty installation.
        const existing = await connection.db.listCollections({ name: args.collection }, { nameOnly: true }).hasNext();
        if (!existing) throw new Error('Explicit target collection does not exist; provision it separately before maintenance');
        const collection = connection.db.collection(args.collection);
        const needsReconciliation = kind === 'repair' && ['apply', 'reconcile', 'verify', 'rollback'].includes(args.mode);
        const header: JournalHeader = { database, collection: args.collection, kind,
            ...(needsReconciliation ? { companions: args.companions } : {}) };
        let companions: ReconciliationCollections | undefined;
        if (needsReconciliation) {
            for (const name of Object.values(args.companions)) {
                if (!(await connection.db.listCollections({ name }, { nameOnly: true }).hasNext())) throw new Error('Explicit companion collection does not exist');
            }
            companions = { bonds: collection, matches: connection.db.collection(args.companions.matches),
                feeds: connection.db.collection(args.companions.feeds), users: connection.db.collection(args.companions.users) };
        }
        if (args.mode === 'reconcile') {
            // Validate the ENTIRE existing file before appending, including a torn/uncertain repair tail.
            for await (const _record of readRepairManifest(args.values['--manifest'], header)) { /* validation only */ }
        }
        if (args.values['--manifest']) journalFile = openMaintenanceJournal(args.values['--manifest'], header, args.mode === 'reconcile');
        const durableJournal: MaintenanceJournal = journalFile?.journal ?? (async () => undefined);
        const batchSize = Number(args.values['--batch-size'] ?? 100);
        const journal: MaintenanceJournal = async entry => {
            await durableJournal(entry);
            if (kind === 'repair' && args.mode === 'rollback' && entry.event === 'rolled-back') {
                await reconcileRepairNative(companions!, entry, reconciliationStore(args.values['--manifest'], durableJournal), { writeWindowConfirmed: true, batchSize });
            }
        };
        if (args.mode === 'dry-run') {
            const report = await preflightMaintenance(collection, batchSize);
            await journal({ event: 'preflight', report });
            console.log(JSON.stringify(report));
            if (report.invalid || report.collisions) process.exitCode = 2;
        } else if (args.mode === 'verify') {
            const report = await verifyMaintenance(collection, kind, batchSize);
            let reconciled = 0;
            if (kind === 'repair') {
                const source = args.values['--reconcile-from'];
                for await (const record of readRepairManifest(source, header)) {
                    await verifyRepairReconciliation(companions!, record, reconciliationStore(source, async () => { throw new Error('Read-only verification'); }));
                    reconciled++;
                }
            }
            console.log(JSON.stringify({ stateVerified: true, ...report,
                ...(kind === 'repair' ? { reconciliationVerified: true, reconciled } : {}) }));
        } else if (args.mode === 'reconcile') {
            const source = args.values['--manifest'];
            let reconciled = 0;
            for await (const record of readRepairManifest(source, header)) {
                await reconcileRepairNative(companions!, record, reconciliationStore(source, durableJournal), { writeWindowConfirmed: true, batchSize });
                reconciled++;
            }
            console.log(JSON.stringify({ reconciled }));
        } else if (args.mode === 'apply') {
            const result = await applyMaintenanceBatch(collection, kind, { journal, batchSize,
                maxDocuments: Number(args.values['--max-documents'] ?? 500), writeWindowConfirmed: true,
                ...(args.values['--after'] ? { after: new mongoose.mongo.ObjectId(args.values['--after']) } : {}) });
            if (kind === 'repair') {
                const source = args.values['--manifest'];
                for await (const record of readRepairManifest(source, header)) {
                    await reconcileRepairNative(companions!, record, reconciliationStore(source, durableJournal), { writeWindowConfirmed: true, batchSize });
                }
            }
            console.log(JSON.stringify(result));
            if (result.conflict) { process.exitCode = 2; return; }
            if (args.values['--create-index']) await installIdentityIndex(collection, { journal, batchSize, writeWindowConfirmed: true });
            if (kind === 'repair') console.log('Applied records reconciled and persisted invariants verified; run whole-state verify before releasing the write window.');
        } else {
            let header = false, restored = 0, conflicts = 0;
            let prepared: WriteManifest | undefined;
            for await (const entry of readJournal(args.values['--rollback-from'])) {
                if (!header) {
                    if (entry.event !== 'header' || entry.format !== 1 || entry.database !== database || entry.collection !== args.collection || entry.kind !== kind
                        || (kind === 'repair' && !isDeepStrictEqual(entry.companions, args.companions))) throw new Error('Rollback manifest target/type mismatch');
                    header = true; continue;
                }
                if (entry.event === 'prepared') {
                    if (prepared) throw new Error('Unresolved prior prepared write; manual reconciliation required');
                    prepared = entry.write;
                }
                if (entry.event === 'applied' || entry.event === 'conflict') {
                    if (!prepared || EJSON.stringify(prepared) !== EJSON.stringify(entry.write)) throw new Error('Applied record lacks matching durable intent');
                    prepared = undefined;
                    if (entry.event === 'applied') {
                        const receipt = kind === 'repair' ? { ...entry, write: await reconciledRollbackManifest(entry.write,
                            reconciliationStore(args.values['--rollback-from'], async () => { throw new Error('Read-only source manifest'); })) } : entry;
                        if (await rollbackMaintenanceWrite(collection, receipt, journal)) restored++; else conflicts++;
                    }
                }
            }
            if (!header || prepared) throw new Error('Empty/incomplete manifest; unresolved writes must be reconciled manually, never guessed');
            console.log(JSON.stringify({ restored, conflicts }));
            if (conflicts) process.exitCode = 2;
        }
    } finally { journalFile?.close(); await connection.close(); }
}

export function reportMaintenanceFailure(error: unknown) {
    // Driver errors can include URI credentials or duplicate key text. Never print their message/stack.
    if (error instanceof MaintenanceBlockedError) console.error(JSON.stringify({ error: 'preflight blocked', report: error.report }));
    else console.error('Maintenance failed. Check explicit arguments/target, connectivity, index compatibility and restricted manifest; use --help. No automatic retry or rollback was attempted.');
    process.exitCode = 1;
}
