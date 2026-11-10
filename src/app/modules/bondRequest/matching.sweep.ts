/* eslint-disable @typescript-eslint/no-explicit-any */
/* Periodic matching sweep: finds cycles that no single bond write triggers by
 * enqueueing recompute for active bonds whose agenda expired, in bounded batches. */
import cron from 'node-cron';
import { expresionCron } from '../../utilities/expresionCron';
import config from '../../config';
import { errorLogger, logger } from '../../shared/logger';
import { ENUM_BOND_REQUEST_STATUS } from './bondRequest.enum';
import BondRequest from './bondRequest.model';
import { contarPendientes, enqueueRecompute } from './matching.robot';
import { agendaVencida } from './matching.schedule';
import { reconciliarVinculosVivos } from '../normalUser/vinculosVivos';

const SWEEP_ENABLED =
    (process.env.MATCH_SWEEP_ENABLED ?? (config.redis_url ? 'true' : 'false'))
        .toLowerCase() === 'true';
const SWEEP_CRON = expresionCron('MATCH_SWEEP_CRON', '*/5 * * * *');

// 1500 per sweep x 12 sweeps/hour = 18k enqueues/h. Real end-to-end capacity is
// the MIN of that and compute capacity (`MATCHER_CONCURRENCY` x
// `MATCH_WORKER_CONCURRENCY`), so 18k only holds with a scaled worker.
//
// Hard cap of 20k bounds a bad env: enqueueing 100k jobs at once kills Redis.
const SWEEP_BATCH = Math.min(
    Math.max(Number(process.env.MATCH_SWEEP_BATCH) || 1500, 1),
    20000
);

// Backpressure: past this threshold the sweep enqueues nothing and waits for the
// next round; links are not lost, their agenda already expired and they stay
// eligible. Jobs always carry explicit priority, so this bounds Redis memory and
// Atlas pressure, not user-facing latency.
const SWEEP_MAX_BACKLOG = Math.max(
    Number(process.env.MATCH_SWEEP_MAX_BACKLOG) || SWEEP_BATCH * 3,
    1
);

/** Enqueues recompute for one batch of active bonds with an expired agenda.
 *  Returns how many were enqueued (0 when stopped by backpressure). */
export const runSweepOnce = async (): Promise<number> => {
    // Backpressure before querying Mongo: with the queue full the query is wasted.
    // `null` = unknown (no Redis, or Redis hiccup); continue on purpose, since the
    // inline mode is already bounded by `inlineRunning`.
    const pendientes = await contarPendientes();
    if (pendientes !== null && pendientes >= SWEEP_MAX_BACKLOG) {
        logger.warn(
            `[matching] sweep en pausa: ${pendientes} pendientes >= ${SWEEP_MAX_BACKLOG}. ` +
                'El worker viene atrasado; se espera la próxima vuelta.'
        );
        return 0;
    }

    // Never enqueue past the threshold: with 300 slots left, enqueue 300, not 1500.
    const cupo =
        pendientes === null
            ? SWEEP_BATCH
            : Math.min(SWEEP_BATCH, SWEEP_MAX_BACKLOG - pendientes);
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

let scheduled = false;
// Anti-overlap: node-cron does not wait for a run to finish. With batch 1500 the
// query plus enqueue is no longer instant, and two overlapping runs would pay for
// the same query twice (`jobId` dedup would absorb the jobs, not the cost).
let running = false;

/** Registers the sweep cron (idempotent). Call once at startup. */
export const startMatchingSweep = (): void => {
    if (!SWEEP_ENABLED) {
        logger.info(
            '[matching] sweep deshabilitado (sin REDIS_URL y sin MATCH_SWEEP_ENABLED=true).'
        );
        return;
    }
    if (scheduled) return;
    scheduled = true;
    cron.schedule(SWEEP_CRON, async () => {
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
        if (running) return; // previous run still going: do not overlap
        running = true;
        try {
            const n = await runSweepOnce();
            if (n) logger.info(`[matching] sweep encoló ${n} recomputos.`);
        } catch (e) {
            errorLogger.error(
                '[matching] sweep falló:',
                (e as Error)?.message
            );
        } finally {
            running = false;
        }
    });
    logger.info(
        `[matching] sweep activo (${SWEEP_CRON}, lote ${SWEEP_BATCH}, techo de cola ${SWEEP_MAX_BACKLOG}).`
    );
};
