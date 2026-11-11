/* Focused sweep tests: execute the real module with only its I/O boundaries
 * stubbed. No config/.env loading, Mongo, Redis, or real timers. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(
    readFileSync(path.join(__dirname, 'matching.sweep.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }
).outputText;

const snapshot = (patch = {}) => Object.freeze({
    candidateMode: 'vector', frontierEnabled: true, cacheTtlMinutes: 60,
    surpriseFloor: 0.45, surpriseMargin: 0.1, frontierSeeds: 5,
    sweepEnabled: true, sweepBatch: 1500, sweepCron: '*/5 * * * *',
    revision: 1, computeRevision: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: null,
    ...patch,
});
type Snapshot = ReturnType<typeof snapshot>;
type Tick = () => void | Promise<void>;
type Task = { expression: string; active: boolean; callback: Tick; start: () => void; stop: () => void };

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function harness(initial = snapshot(), env: Record<string, string> = {}) {
    const state = {
        settings: initial, reads: [] as (boolean | undefined)[],
        load: undefined as (() => Promise<Snapshot>) | undefined,
        backlog: 0 as number | null,
        count: undefined as (() => Promise<number | null>) | undefined,
        countCalls: 0, queries: [] as Record<string, unknown>[], limits: [] as number[],
        sorts: [] as unknown[], selects: [] as string[], enqueued: [] as string[],
        rows: [{ _id: 'bond-a', matchesNextAt: new Date(0) }, { _id: 'bond-b', matchesNextAt: new Date(0) }],
        reconciliations: 0, reconcile: undefined as (() => Promise<void>) | undefined,
        tasks: [] as Task[], events: [] as string[], registry: new Map<string, Task>(),
        timers: new Map<number, Tick>(), timerDelays: [] as number[], timerId: 0,
        scheduleFailure: false, errors: [] as unknown[][],
    };
    const cursor = {
        sort(value: unknown) { state.sorts.push(value); return cursor; },
        limit(value: number) { state.limits.push(value); return cursor; },
        select(value: string) { state.selects.push(value); return cursor; },
        async lean() { return state.rows.slice(0, state.limits.at(-1)); },
    };
    const dependencies: Record<string, unknown> = {
        'node-cron': {
            schedule(expression: string, callback: Tick, options?: { name?: string; scheduled?: boolean }) {
                state.events.push(`schedule:${expression}`);
                if (state.scheduleFailure) throw new Error('cron failed');
                const task: Task = {
                    expression, callback, active: options?.scheduled !== false,
                    start() { task.active = true; state.events.push(`start:${expression}`); },
                    stop() { task.active = false; state.events.push(`stop:${expression}`); },
                };
                state.tasks.push(task);
                state.registry.set(options?.name ?? `unnamed-${state.tasks.length}`, task);
                return task;
            },
        },
        // Legacy imports allow these tests to demonstrate failures before the refactor.
        '../../utilities/expresionCron': { expresionCron: (_: string, fallback: string) => fallback },
        '../../config': { redis_url: 'stubbed-redis' },
        '../../shared/logger': {
            logger: { info() {}, warn() {} },
            errorLogger: { error: (...args: unknown[]) => state.errors.push(args) },
        },
        './bondRequest.enum': { ENUM_BOND_REQUEST_STATUS: { WAITING_FOR_LINK: 'WAITING_FOR_LINK' } },
        './bondRequest.model': { find(query: Record<string, unknown>) { state.queries.push(query); return cursor; } },
        './matching.robot': {
            contarPendientes: async () => { state.countCalls++; return state.count ? state.count() : state.backlog; },
            enqueueRecompute: (id: string) => state.enqueued.push(id),
        },
        './matching.schedule': { agendaVencida: () => new Date(0) },
        '../normalUser/vinculosVivos': { reconciliarVinculosVivos: async () => {
            state.reconciliations++;
            await state.reconcile?.();
            return { encendidos: 0, apagados: 0 };
        } },
        '../settings/matchingSettings.service': { getMatchingSettings: async (force?: boolean) => {
            state.reads.push(force);
            return state.load ? state.load() : state.settings;
        } },
    };
    const exports: Record<string, unknown> = {};
    vm.runInNewContext(source, {
        exports, Date, process: { env },
        require: (name: string) => {
            assert.ok(Object.hasOwn(dependencies, name), `Unstubbed import: ${name}`);
            return dependencies[name];
        },
        setInterval: (callback: Tick, delay: number) => {
            state.timerDelays.push(delay);
            const id = ++state.timerId;
            state.timers.set(id, callback);
            return id;
        },
        clearInterval: (id: number) => state.timers.delete(id),
    }, { filename: 'matching.sweep.js' });
    const api = exports as unknown as {
        startMatchingSweep: () => Promise<void>;
        stopMatchingSweep: () => void;
        runSweepOnce: () => Promise<number>;
    };
    return {
        state, api,
        async poll() {
            assert.equal(state.timers.size, 1, 'exactly one settings refresh timer');
            await [...state.timers.values()][0]();
        },
    };
}

export async function runMatchingSweepTests(): Promise<{ pass: number; fail: number }> {
    let pass = 0, fail = 0;
    const test = async (name: string, run: () => Promise<void>) => {
        try { await run(); pass++; }
        catch (error) { fail++; console.error(`FAIL matching.sweep: ${name}`, error); }
    };

    await test('disabled startup still polls and can enable without restart', async () => {
        const h = harness(snapshot({ sweepEnabled: false }));
        await h.api.startMatchingSweep();
        assert.equal(h.state.tasks.length, 0);
        assert.deepEqual(h.state.timerDelays, [5000]);
        h.state.settings = snapshot();
        await h.poll();
        assert.equal(h.state.tasks.filter(t => t.active).length, 1);
        assert.deepEqual(h.state.reads, [true, true]);
        h.api.stopMatchingSweep();
    });
    await test('cron replacement stops old task first and uses one stable registry name', async () => {
        const h = harness();
        await h.api.startMatchingSweep();
        const old = h.state.tasks[0];
        h.state.settings = snapshot({ sweepCron: '*/2 * * * *' });
        await h.poll();
        assert.equal(old.active, false);
        assert.equal(h.state.tasks[1].active, true);
        assert.ok(h.state.events.indexOf(`stop:${old.expression}`) < h.state.events.indexOf('schedule:*/2 * * * *'));
        assert.deepEqual([...h.state.registry.keys()], ['matching-sweep']);
        await old.callback();
        assert.equal(h.state.reconciliations, 0, 'retired callbacks cannot start work');
        h.api.stopMatchingSweep();
    });
    await test('disable stops cron but not polling, and callbacks stay inert', async () => {
        const h = harness();
        await h.api.startMatchingSweep();
        const task = h.state.tasks[0];
        h.state.settings = snapshot({ sweepEnabled: false });
        await h.poll();
        assert.equal(task.active, false);
        assert.equal(h.state.timers.size, 1);
        await task.callback();
        assert.equal(h.state.countCalls, 0);
        h.api.stopMatchingSweep();
        assert.equal(h.state.timers.size, 0);
    });
    await test('batch-only change uses new batch without replacing cron', async () => {
        const h = harness();
        await h.api.startMatchingSweep();
        h.state.settings = snapshot({ sweepBatch: 7 });
        await h.poll();
        await h.state.tasks[0].callback();
        assert.equal(h.state.tasks.length, 1);
        assert.deepEqual(h.state.limits, [7]);
        h.api.stopMatchingSweep();
    });
    await test('repeated starts and overlapping polls never duplicate tasks, timers, or reads', async () => {
        const h = harness();
        await Promise.all([h.api.startMatchingSweep(), h.api.startMatchingSweep()]);
        await h.api.startMatchingSweep();
        assert.equal(h.state.tasks.length, 1);
        assert.deepEqual(h.state.timerDelays, [5000]);
        const pending = deferred<Snapshot>();
        h.state.load = () => pending.promise;
        const first = h.poll();
        const second = h.poll();
        assert.equal(h.state.reads.length, 2);
        pending.resolve(snapshot());
        await Promise.all([first, second]);
        h.api.stopMatchingSweep();
    });
    await test('refresh failure retains prior settings and task, then recovers', async () => {
        const h = harness(snapshot({ sweepBatch: 9 }));
        await h.api.startMatchingSweep();
        h.state.load = async () => { throw new Error('settings unavailable'); };
        await h.poll();
        assert.equal(h.state.tasks[0].active, true);
        assert.equal(h.state.errors.length, 1);
        await h.state.tasks[0].callback();
        assert.deepEqual(h.state.limits, [9]);
        h.state.load = undefined;
        h.state.settings = snapshot({ sweepEnabled: false });
        await h.poll();
        assert.equal(h.state.tasks[0].active, false);
        h.api.stopMatchingSweep();
    });
    await test('failed cron replacement retains working task and retries', async () => {
        const h = harness();
        await h.api.startMatchingSweep();
        h.state.settings = snapshot({ sweepCron: '*/2 * * * *' });
        h.state.scheduleFailure = true;
        await h.poll();
        assert.equal(h.state.tasks[0].active, true);
        assert.equal(h.state.errors.length, 1);
        h.state.scheduleFailure = false;
        await h.poll();
        assert.equal(h.state.tasks.filter(t => t.active).length, 1);
        assert.equal(h.state.tasks.at(-1)?.expression, '*/2 * * * *');
        h.api.stopMatchingSweep();
    });
    await test('shutdown prevents late polling completion from rearming', async () => {
        const h = harness();
        await h.api.startMatchingSweep();
        const pending = deferred<Snapshot>();
        h.state.load = () => pending.promise;
        const poll = h.poll();
        h.api.stopMatchingSweep();
        h.api.stopMatchingSweep();
        pending.resolve(snapshot({ sweepCron: '*/2 * * * *' }));
        await poll;
        assert.equal(h.state.tasks.filter(t => t.active).length, 0);
        assert.equal(h.state.timers.size, 0);
        assert.equal(h.state.tasks.length, 1);
    });
    await test('shutdown during initial read does not install a task or timer', async () => {
        const h = harness();
        const pending = deferred<Snapshot>();
        h.state.load = () => pending.promise;
        const starting = h.api.startMatchingSweep();
        h.api.stopMatchingSweep();
        pending.resolve(snapshot());
        await starting;
        assert.equal(h.state.tasks.length, 0);
        assert.equal(h.state.timers.size, 0);
    });
    await test('missing startup settings reject clearly and leave no timers', async () => {
        const h = harness();
        h.state.load = async () => { throw new Error('Matching settings missing; initialize API first'); };
        await assert.rejects(async () => h.api.startMatchingSweep(), /initialize API first/);
        assert.equal(h.state.tasks.length, 0);
        assert.equal(h.state.timers.size, 0);
        h.state.load = undefined;
        await h.api.startMatchingSweep();
        assert.equal(h.state.tasks.length, 1);
        h.api.stopMatchingSweep();
    });
    await test('backpressure skips Mongo and defaults to current batch times three', async () => {
        const h = harness(snapshot({ sweepBatch: 10 }));
        h.state.backlog = 30;
        assert.equal(await h.api.runSweepOnce(), 0);
        assert.equal(h.state.queries.length, 0);
        h.state.settings = snapshot({ sweepBatch: 20 });
        assert.equal(await h.api.runSweepOnce(), 2);
        assert.deepEqual(h.state.limits, [20]);
    });
    await test('explicit backlog override limits remaining slots and preserves indexed expiry query', async () => {
        const h = harness(snapshot({ sweepBatch: 10 }), { MATCH_SWEEP_MAX_BACKLOG: '12' });
        h.state.backlog = 11;
        assert.equal(await h.api.runSweepOnce(), 1);
        assert.deepEqual(h.state.limits, [1]);
        assert.deepEqual(h.state.enqueued, ['bond-a']);
        const query = h.state.queries[0];
        assert.equal(query.status, 'WAITING_FOR_LINK');
        assert.equal(query.isPause, false);
        assert.equal(query.isLinked, false);
        assert.ok((query.matchesNextAt as { $lte: Date }).$lte instanceof Date);
        assert.equal(JSON.stringify(h.state.sorts[0]), '{"matchesNextAt":1}');
        assert.deepEqual(h.state.selects, ['_id matchesNextAt']);
        h.state.backlog = 12;
        assert.equal(await h.api.runSweepOnce(), 0);
        assert.equal(h.state.queries.length, 1);
    });
    await test('unknown backlog uses bounded batch and disabled direct sweep does nothing', async () => {
        const h = harness(snapshot({ sweepBatch: 25000 }));
        h.state.backlog = null;
        await h.api.runSweepOnce();
        assert.deepEqual(h.state.limits, [20000]);
        h.state.settings = snapshot({ sweepEnabled: false });
        assert.equal(await h.api.runSweepOnce(), 0);
        assert.equal(h.state.countCalls, 1);
    });
    await test('in-flight sweep retains its batch and can finish after disable', async () => {
        const h = harness(snapshot({ sweepBatch: 8 }));
        await h.api.startMatchingSweep();
        const pending = deferred<number | null>();
        h.state.count = () => pending.promise;
        const tick = h.state.tasks[0].callback();
        // Drain the reconciliation await, not a real timer.
        for (let i = 0; i < 8; i++) await Promise.resolve();
        assert.equal(h.state.countCalls, 1);
        h.state.settings = snapshot({ sweepEnabled: false, sweepBatch: 2 });
        await h.poll();
        pending.resolve(0);
        await tick;
        assert.deepEqual(h.state.limits, [8]);
        assert.equal(h.state.enqueued.length, 2);
        h.api.stopMatchingSweep();
    });
    await test('reconciliation still precedes overlap guard even while queue count hangs', async () => {
        const h = harness();
        await h.api.startMatchingSweep();
        const pending = deferred<number | null>();
        h.state.count = () => pending.promise;
        const first = h.state.tasks[0].callback();
        for (let i = 0; i < 8; i++) await Promise.resolve();
        await h.state.tasks[0].callback();
        assert.equal(h.state.reconciliations, 2);
        assert.equal(h.state.countCalls, 1);
        pending.resolve(0);
        await first;
        h.api.stopMatchingSweep();
    });
    await test('shutdown during reconciliation does not start a new sweep', async () => {
        const h = harness();
        await h.api.startMatchingSweep();
        const pending = deferred<void>();
        h.state.reconcile = () => pending.promise;
        const tick = h.state.tasks[0].callback();
        h.api.stopMatchingSweep();
        pending.resolve();
        await tick;
        assert.equal(h.state.countCalls, 0);
    });
    await test('restart waits for retired refresh and installs exactly one fresh scheduler', async () => {
        const h = harness();
        await h.api.startMatchingSweep();
        const pending = deferred<Snapshot>();
        h.state.load = () => pending.promise;
        const poll = h.poll();
        h.api.stopMatchingSweep();
        const restarted = h.api.startMatchingSweep();
        assert.equal(h.state.reads.length, 2);
        h.state.load = undefined;
        h.state.settings = snapshot({ sweepCron: '*/3 * * * *' });
        pending.resolve(snapshot({ sweepCron: '*/2 * * * *' }));
        await Promise.all([poll, restarted]);
        assert.equal(h.state.timers.size, 1);
        assert.equal(h.state.tasks.length, 2);
        assert.equal(h.state.tasks.filter(t => t.active).length, 1);
        assert.equal(h.state.tasks.at(-1)?.expression, '*/3 * * * *');
        h.api.stopMatchingSweep();
    });
    await test('reconciliation and queue errors are logged without locking later sweeps', async () => {
        const h = harness();
        await h.api.startMatchingSweep();
        h.state.reconcile = async () => { throw new Error('reconcile failed'); };
        h.state.count = async () => { throw new Error('queue failed'); };
        await h.state.tasks[0].callback();
        assert.equal(h.state.errors.length, 2);
        h.state.reconcile = undefined;
        h.state.count = undefined;
        await h.state.tasks[0].callback();
        assert.equal(h.state.enqueued.length, 2);
        h.api.stopMatchingSweep();
    });
    await test('worker forces settings load after Mongo and before starting consumer', async () => {
        const h = workerHarness();
        await h.main;
        assert.deepEqual(h.events.slice(0, 4), ['db:connect', 'settings:true', 'worker:start', 'sweep:start']);
    });
    await test('worker awaits sweep startup before announcing ready', async () => {
        const pending = deferred<void>();
        const h = workerHarness({ sweep: () => pending.promise });
        for (let i = 0; i < 8; i++) await Promise.resolve();
        assert.ok(h.events.includes('sweep:start'));
        assert.equal(h.events.includes('ready'), false);
        pending.resolve();
        await h.main;
        assert.equal(h.events.includes('ready'), true);
    });
    await test('uninitialized settings fail worker startup without consumption or seeding', async () => {
        const h = workerHarness({ missing: true });
        await h.main;
        assert.ok(h.events.includes('exit:1'));
        assert.equal(h.events.includes('worker:start'), false);
        assert.equal(h.events.includes('sweep:start'), false);
        assert.match(String(h.errors[0]), /initialize API first/);
    });
    await test('secondary worker loads settings but never starts sweep', async () => {
        const h = workerHarness({ leader: false });
        await h.main;
        assert.ok(h.events.includes('settings:true'));
        assert.ok(h.events.includes('worker:start'));
        assert.equal(h.events.includes('sweep:start'), false);
    });
    await test('worker shutdown stops sweep before closing queue and database', async () => {
        const h = workerHarness();
        await h.main;
        h.events.length = 0;
        h.handlers.get('SIGTERM')!();
        for (let i = 0; i < 8; i++) await Promise.resolve();
        assert.deepEqual(h.events, ['sweep:stop', 'robot:close', 'db:close', 'exit:0']);
    });
    return { pass, fail };
}

function workerHarness(options: { missing?: boolean; leader?: boolean; sweep?: () => Promise<void> } = {}) {
    const events: string[] = [];
    const errors: unknown[][] = [];
    const handlers = new Map<string, () => void>();
    const dependencies: Record<string, unknown> = {
        mongoose: { connect: async () => { events.push('db:connect'); }, connection: { close: async () => { events.push('db:close'); } } },
        './app/config': { database_url: 'stubbed-mongo' },
        './app/shared/logger': {
            logger: { info(message: string) { if (message.includes('Matching worker process started')) events.push('ready'); } },
            errorLogger: { error: (...args: unknown[]) => errors.push(args) },
        },
        './app/utilities/instancia': { esInstanciaLider: () => options.leader !== false, etiquetaInstancia: () => 'test' },
        './app/modules/bondRequest/matching.robot': {
            startMatchingWorker: () => events.push('worker:start'),
            closeMatchingRobot: async () => { events.push('robot:close'); },
        },
        './app/modules/bondRequest/matching.sweep': {
            startMatchingSweep: async () => { events.push('sweep:start'); await options.sweep?.(); },
            stopMatchingSweep: () => events.push('sweep:stop'),
        },
        './app/modules/settings/matchingSettings.service': { getMatchingSettings: async (force?: boolean) => {
            events.push(`settings:${force}`);
            if (options.missing) throw new Error('Matching settings missing; initialize API first');
            return snapshot();
        } },
        './app/modules/audio/audio.sweep': { startAudioSweep() {} },
        './app/modules/audio/trending.sweep': { startTrendingSweep() {} },
        './app/modules/notificationDigest/digest.cron': { startDigestCron() {} },
        './app/modules/bondLink/bondLink.reminderSweep': { startCompletionReminderSweep() {} },
    };
    const workerSource = ts.transpileModule(
        readFileSync(path.join(__dirname, '../../../worker.ts'), 'utf8'),
        { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }
    ).outputText;
    const main = vm.runInNewContext(workerSource, {
        exports: {},
        require: (name: string) => {
            assert.ok(Object.hasOwn(dependencies, name), `Unstubbed worker import: ${name}`);
            return dependencies[name];
        },
        process: {
            on: (signal: string, callback: () => void) => handlers.set(signal, callback),
            exit: (code: number) => events.push(`exit:${code}`),
        },
        setTimeout: () => ({ unref() {} }),
    }, { filename: 'worker.js' }) as Promise<void>;
    return { events, errors, handlers, main };
}
