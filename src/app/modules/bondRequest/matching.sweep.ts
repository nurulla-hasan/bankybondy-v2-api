/* eslint-disable @typescript-eslint/no-explicit-any */
/* Periodic matching sweep: finds cycles that no single bond write triggers by
 * enqueueing recompute for active bonds whose agenda expired, in bounded batches. */
import cron from 'node-cron';
import { getMatchingSettings } from '../settings/matchingSettings.service';
import type { MatchingSettingsSnapshot } from '../settings/matchingSettings.interface';
import { errorLogger, logger } from '../../shared/logger';
import { ENUM_BOND_REQUEST_STATUS } from './bondRequest.enum';
import BondRequest from './bondRequest.model';
import { contarPendientes, enqueueRecompute } from './matching.robot';
import { agendaVencida } from './matching.schedule';
import { reconciliarVinculosVivos } from '../normalUser/vinculosVivos';

// Only an explicit operational backlog override remains environment-owned.
// Otherwise derive it from the SAME snapshot as the batch, on every run.
const SWEEP_MAX_BACKLOG = Number(process.env.MATCH_SWEEP_MAX_BACKLOG) || undefined;

const sweepLimits = (settings: Readonly<MatchingSettingsSnapshot>) => {
    // Retain the hard 20k cap: enqueueing 100k jobs at once kills Redis.
    const batch = Math.min(Math.max(settings.sweepBatch, 1), 20000);
    return { batch, maxBacklog: Math.max(SWEEP_MAX_BACKLOG ?? batch * 3, 1) };
};

/** Enqueues recompute for one batch of active bonds with an expired agenda.
 *  Returns 0 when disabled or stopped by backpressure. A started batch keeps its
 *  snapshot and may finish after the scheduler is disabled. */
export const runSweepOnce = async (
    snapshot?: Readonly<MatchingSettingsSnapshot>
): Promise<number> => {
    const settings = snapshot ?? await getMatchingSettings();
    if (!settings.sweepEnabled) return 0;
    const { batch: sweepBatch, maxBacklog } = sweepLimits(settings);
    // Backpressure before querying Mongo: with the queue full the query is wasted.
    // `null` = unknown (no Redis, or Redis hiccup); continue on purpose, since the
    // inline mode is already bounded by `inlineRunning`.
    const pendientes = await contarPendientes();
    if (pendientes !== null && pendientes >= maxBacklog) {
        logger.warn(
            `[matching] sweep en pausa: ${pendientes} pendientes >= ${maxBacklog}. ` +
                'El worker viene atrasado; se espera la próxima vuelta.'
        );
        return 0;
    }

    // Never enqueue past the threshold: with 300 slots left, enqueue 300, not 1500.
    const cupo =
        pendientes === null
            ? sweepBatch
            : Math.min(sweepBatch, maxBacklog - pendientes);
    if (cupo <= 0) return 0;

    const ahora = new Date();

    // Adaptive TTL: filter by the agenda (`matchesNextAt`), not by history
    // (`matchesComputedAt`). No policy here, just reading what each link was
    // assigned at compute time (see matching.schedule.ts).
    //
    // Query shaped so the index also provides the ORDER: otherwise Mongo adds a
    // blocking SORT (32 MB cap over ~40 KB docs, ~60 MB at batch 1500), the catch
    // below swallows it, and nothing is ever recomputed again, silently.
    // Everything before the sort key must be EQUALITY: `isLinked: false` and not
    // `{$ne: true}`, `$lte` and not a `$or` with `$exists: false` (hence the
    // AGENDA_VENCIDA sentinel instead of an absent field).
    //
    // Eligibility comes from a BondRequest field, not from BondMatch rows: a bond
    // with no matches creates no rows and would be recomputed forever.
    const batch = await BondRequest.find({
        status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
        isPause: false,
        isLinked: false,
        matchesNextAt: { $lte: ahora },
    })
        // Most overdue first; never-computed and just-invalidated links carry the
        // epoch sentinel, so they lead on their own.
        .sort({ matchesNextAt: 1 })
        .limit(cupo)
        .select('_id matchesNextAt')
        .lean();

    // Instrumentation: age of the most overdue link, telling "nothing to do" apart
    // from "something is not being recomputed". Sentinel rows are counted
    // separately, since their age would read from 1970.
    const centinela = +agendaVencida();
    const sinComputar = (batch as any[]).filter(
        (b) => +new Date(b.matchesNextAt) === centinela
    ).length;
    const masAtrasado = (batch as any[]).find(
        (b) => +new Date(b.matchesNextAt) !== centinela
    );
    logger.info(
        `[matching] agenda: ${batch.length} vencidos (cupo ${cupo}) · ${sinComputar} sin computar · el más atrasado espera ${
            masAtrasado
                ? `${Math.round((ahora.getTime() - +new Date(masAtrasado.matchesNextAt)) / 60000)} min`
                : batch.length === cupo
                  ? 'sin ver (lote lleno de centinelas)'
                  : '—'
        }`
    );

    for (const b of batch as any[]) {
        enqueueRecompute(b._id.toString());
    }
    return batch.length;
};

let scheduledTask: cron.ScheduledTask | undefined;
let currentSettings: Readonly<MatchingSettingsSnapshot> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let refreshInFlight: Promise<void> | undefined;
let starting: Promise<void> | undefined;
let started = false;
let generation = 0;
// Anti-overlap: node-cron does not wait for a run to finish. With batch 1500 the
// query plus enqueue is no longer instant, and two overlapping runs would pay for
// the same query twice (`jobId` dedup would absorb the jobs, not the cost).
let running = false;

const runScheduledSweep = async (task: cron.ScheduledTask): Promise<void> => {
    const isCurrent = () => started && scheduledTask === task && currentSettings?.sweepEnabled;
    if (!isCurrent()) return;
    const snapshot = currentSettings!;
    // Safety net for `hasActiveBonds` (Person order): repairs anything the
    // write-time recompute missed. Runs BEFORE the anti-overlap guard and apart
    // from the sweep, because with Redis down `contarPendientes` waits forever
    // (`maxRetriesPerRequest: null`) and would leave `running` stuck at true.
    // Logs only when it corrects something: a single fix can be a race with a
    // concurrent write (the next round settles it), fixes every round are a bug.
    try {
        const r = await reconciliarVinculosVivos();
        if (r.encendidos || r.apagados) {
            logger.warn(
                `[vinculosVivos] reconciliación corrigió ${r.encendidos} encendidos y ${r.apagados} apagados`
            );
        }
    } catch (e) {
        errorLogger.error(
            '[vinculosVivos] reconciliación falló:',
            (e as Error)?.message
        );
    }
    // Recheck after reconciliation: disable/shutdown may have retired this task.
    if (!isCurrent() || running) return;
    running = true;
    try {
        const n = await runSweepOnce(snapshot);
        if (n) logger.info(`[matching] sweep encoló ${n} recomputos.`);
    } catch (e) {
        errorLogger.error('[matching] sweep falló:', (e as Error)?.message);
    } finally {
        running = false;
    }
};

const applySweepSettings = (settings: Readonly<MatchingSettingsSnapshot>): void => {
    if (settings.sweepEnabled && (!scheduledTask || currentSettings?.sweepCron !== settings.sweepCron)) {
        const previous = scheduledTask;
        previous?.stop();
        let next: cron.ScheduledTask | undefined;
        try {
            // Installed node-cron v3 has stop/start, not destroy. A stable name
            // replaces its registry entry instead of retaining every retired task.
            const task = cron.schedule(settings.sweepCron, () => runScheduledSweep(task), {
                name: 'matching-sweep', scheduled: false,
            });
            next = task;
            task.start();
            scheduledTask = task;
        } catch (error) {
            next?.stop();
            previous?.start();
            throw error; // Keep the last applied snapshot and retry next poll.
        }
    } else if (!settings.sweepEnabled) {
        scheduledTask?.stop();
        scheduledTask = undefined;
    }
    if (!currentSettings || currentSettings.sweepEnabled !== settings.sweepEnabled ||
        currentSettings.sweepCron !== settings.sweepCron || currentSettings.sweepBatch !== settings.sweepBatch) {
        const { batch, maxBacklog } = sweepLimits(settings);
        logger.info(settings.sweepEnabled
            ? `[matching] sweep activo (${settings.sweepCron}, lote ${batch}, techo de cola ${maxBacklog}).`
            : '[matching] sweep deshabilitado por settings; sincronización sigue activa.');
    }
    currentSettings = settings;
};

const refreshSweepSettings = (): Promise<void> => {
    if (refreshInFlight) return refreshInFlight;
    const version = generation;
    refreshInFlight = (async () => {
        const settings = await getMatchingSettings(true);
        // A read that finishes after stop (or a later start) cannot rearm cron.
        if (!started || version !== generation) return;
        applySweepSettings(settings);
    })().finally(() => { refreshInFlight = undefined; });
    return refreshInFlight;
};

/** Leader only. Idempotent startup; settings refresh runs even while disabled. */
export const startMatchingSweep = (): Promise<void> => {
    if (started) return starting ?? Promise.resolve();
    started = true;
    const version = ++generation;
    starting = (async () => {
        // A stopped session's read may still be settling. Do not overlap it.
        if (refreshInFlight) await refreshInFlight.catch(() => undefined);
        if (!started || version !== generation) return;
        await refreshSweepSettings(); // No snapshot at startup must fail visibly.
        if (!started || version !== generation) return;
        refreshTimer = setInterval(async () => {
            // Skip, rather than stack waiting timer callbacks on a slow read.
            if (!started || version !== generation || refreshInFlight) return;
            try {
                await refreshSweepSettings();
            } catch (error) {
                errorLogger.error('[matching] sweep settings refresh falló; se conserva la configuración anterior:', error);
            }
        }, 5000);
    })().catch((error: unknown) => {
        if (version === generation) stopMatchingSweep();
        throw error;
    });
    return starting;
};

/** Stops producers, not an already-running batch. Safe during an in-flight read. */
export const stopMatchingSweep = (): void => {
    started = false;
    generation++;
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    refreshTimer = undefined;
    scheduledTask?.stop();
    scheduledTask = undefined;
    currentSettings = undefined;
    starting = undefined;
};
