/* eslint-disable @typescript-eslint/no-explicit-any */
/* Matching robot: background compute engine.
 * With REDIS_URL, a BullMQ worker recomputes off-request; without it, in-process fire-and-forget.
 */
import { Queue, Worker, Job } from 'bullmq';
import mongoose from 'mongoose';
import { performance } from 'perf_hooks';
import config from '../../config';
import { errorLogger, logger } from '../../shared/logger';
import BondMatch from '../bondMatch/bondMatch.model';
import BondMatchFeed from '../bondMatch/bondMatchFeed.model';
import { ENUM_BOND_REQUEST_STATUS } from './bondRequest.enum';
import BondRequest from './bondRequest.model';
import { MATCHING } from './matching.config';
import { computeAndCacheMatches } from './matching.compute';
import { AGENDA, agendaVencida } from './matching.schedule';
import { notifyNewMatches } from './matching.notify';

const QUEUE_NAME = 'bond-matching';

// ---- connection / queue / worker (lazy, cached) ----

// Pass connection OPTIONS, not a client: a shared ioredis instance may belong to a
// different module copy than the one BullMQ bundles, so its checks/state fail and
// `queue.add()` rejects, silently degrading everything to slow inline compute.
// With options BullMQ creates and owns its own client (correct version, blocking
// connections included).
type RedisConnOpts = {
    host: string;
    port: number;
    username?: string;
    password?: string;
    db?: number;
    tls?: Record<string, unknown>;
    maxRetriesPerRequest: null;
};

let connOptsBuilt = false;
let connOpts: RedisConnOpts | undefined;
/** Parses REDIS_URL (redis:// | rediss://) into BullMQ connection options. */
const getConnectionOptions = (): RedisConnOpts | undefined => {
    if (!config.redis_url) return undefined;
    if (connOptsBuilt) return connOpts;
    connOptsBuilt = true;
    try {
        const u = new URL(config.redis_url);
        const isTls = u.protocol === 'rediss:';
        const dbStr = (u.pathname || '').replace(/^\//, '');
        connOpts = {
            host: u.hostname,
            port: u.port ? Number(u.port) : 6379,
            // BullMQ requires null so commands aren't aborted during reconnects.
            maxRetriesPerRequest: null,
            ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
            ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
            ...(dbStr ? { db: Number(dbStr) } : {}),
            ...(isTls ? { tls: {} } : {}),
        };
    } catch (e: any) {
        errorLogger.error('[matching] REDIS_URL inválida', {
            message: e?.message,
            name: e?.name,
            code: e?.code,
        });
        connOpts = undefined;
    }
    return connOpts;
};

let queue: Queue | undefined;
const getQueue = (): Queue | undefined => {
    const opts = getConnectionOptions();
    if (!opts) return undefined;
    // BullMQ creates and owns its own ioredis client from these options
    // (dedicated to the Queue, independent of the Worker).
    if (!queue) queue = new Queue(QUEUE_NAME, { connection: opts as any });
    return queue;
};

// ---- single-bond recompute ----

/** Recomputes and caches a bond's matches; clears its cache if the bond is no longer active. */
const recomputeBond = async (bondId: string): Promise<void> => {
    const startRequest = await BondRequest.findOne({
        _id: bondId,
        status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
        isPause: false,
        isLinked: { $ne: true },
    })
        // `createdAt`/`lastServedAt` feed the temperature-based next recompute
        // (adaptive TTL); without them every bond would come out 'frio'.
        .select(
            'offer want offerVector wantVector location radius user modality createdAt lastServedAt matchesGen'
        )
        .lean();

    if (!startRequest) {
        const oid = new mongoose.Types.ObjectId(bondId);
        await BondMatch.deleteMany({
            sourceBond: oid,
        });
        // Feed rows of a bond that is no longer recomputable (paused/deleted/linked)
        // must not survive: they could still be served.
        if (MATCHING.feedWrite) {
            await BondMatchFeed.deleteMany({ bonds: oid });
        }
        return;
    }

    const userId = (
        (startRequest as any).user?._id || (startRequest as any).user
    )?.toString();

    // Snapshot the match signatures already persisted for this bond before the
    // recompute; comparing before/after reveals NEW matches to notify the owner.
    // Read-only: does not touch scoring or persistence.
    const previous = await BondMatch.find({ sourceBond: bondId })
        .select('bonds')
        .lean();
    const previousSignatures = new Set<string>(
        (previous as any[]).map((m) =>
            (m.bonds || [])
                .map((id: any) => id.toString())
                .sort()
                .join('|')
        )
    );

    // computeAndCacheMatches persists and returns the freshly stored records.
    const records = await computeAndCacheMatches(startRequest, userId);

    // A1 (symmetric freshness): counterparts of a NEW match don't have this bond
    // in their cache yet, so enqueue their recompute — only for new matches, low
    // priority, capped fan-out. Self-terminating: once they include this bond it is
    // no longer new for them. Fire-and-forget.
    const freshCounterparties = new Set<string>();
    for (const r of records) {
        const sig = [...r.ids]
            .map((id) => id.toString())
            .sort()
            .join('|');
        if (previousSignatures.has(sig)) continue; // already existed → not new
        for (const id of r.ids) {
            const s = id.toString();
            if (s !== bondId.toString()) freshCounterparties.add(s);
        }
    }
    if (freshCounterparties.size) {
        [...freshCounterparties]
            .slice(0, MATCHING.invalidationFanout)
            .forEach((id) => enqueueRecompute(id));
    }

    // Side effect only: notify new matches (fire-and-forget, must never break the recompute).
    notifyNewMatches({
        userId,
        bondRequestId: bondId,
        records,
        previousSignatures,
        // So the notification says which of the user's bonds matched.
        sourceOffer: (startRequest as any)?.offer,
        sourceWant: (startRequest as any)?.want,
    }).catch((e) =>
        errorLogger.error(
            '[matching] notifyNewMatches fallo:',
            (e as Error)?.message
        )
    );
};

// Only the WORKER process computes inline (startMatchingWorker flips the flag).
// The API keeps it false: if enqueue fails (Redis down) it must not put O(N^2)
// compute on its event loop — the bond stays pending and the sweep recovers it.
let INLINE_ENABLED = false;

// Prevents recomputing the same bond concurrently in-process.
const inlineRunning = new Set<string>();
const runInlineRecompute = (bondId: string): void => {
    if (inlineRunning.has(bondId)) return;
    inlineRunning.add(bondId);
    setImmediate(async () => {
        try {
            await recomputeBond(bondId);
        } catch (e) {
            errorLogger.error(
                '[matching] recomputo inline fallo:',
                (e as Error)?.message
            );
        } finally {
            inlineRunning.delete(bondId);
        }
    });
};

// BullMQ priority: LOWER runs first. User actions (create/propose/view) go HIGH so
// they don't wait behind the sweep batch; sweep and background bonds go LOW. Always
// explicit (never 0): BullMQ lets "no priority" jobs overtake prioritized ones.
export const MATCH_PRIORITY_USER = 1;
export const MATCH_PRIORITY_BG = 100;

/** Enqueues a recompute (inline if no Redis). Fire-and-forget.
 *  `priority`: MATCH_PRIORITY_USER for user actions, otherwise MATCH_PRIORITY_BG. */
export const enqueueRecompute = (
    bondId: string,
    priority: number = MATCH_PRIORITY_BG
): void => {
    const q = getQueue();
    if (q) {
        q.add(
            'recompute',
            { bondId },
            {
                jobId: `rc-${bondId}`,
                priority,
                removeOnComplete: true,
                // MUST be `true`. The jobId above is deterministic (`rc-<bondId>`),
                // which is what dedupes work — but a retained failed job (the old
                // `removeOnFail: 50`) keeps that id taken, so every later `add` for
                // the bond silently enqueues nothing and it is never recomputed
                // again, by user or sweep. Deleting it frees the id; the
                // `worker.on('failed')` log below keeps the trail.
                removeOnFail: true,
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
            }
        ).catch((e: any) => {
            // Log the real error (not just the message) to diagnose enqueue failures.
            errorLogger.error('[matching] fallo al encolar', {
                message: e?.message,
                name: e?.name,
                code: e?.code,
            });
            // In the API, on enqueue failure we don't block the event loop: the sweep recovers.
            if (INLINE_ENABLED) runInlineRecompute(bondId);
        });
        return;
    }
    // No queue (no Redis): only the worker computes inline.
    if (INLINE_ENABLED) runInlineRecompute(bondId);
};

/** Pending queue work (waiting + delayed), used by the sweep for backpressure.
 *
 *  Raising the batch while the worker lags only adds queue depth and delays the
 *  user's HIGH-priority jobs. Returns `null` when unknown (no Redis, or a hiccup)
 *  so the caller decides: a fake 0 would disable backpressure exactly when needed. */
export const contarPendientes = async (): Promise<number | null> => {
    const q = getQueue();
    if (!q) return null;
    try {
        // Use `Queue.count()` rather than summing states by hand: we always enqueue
        // with explicit priority, so jobs live in `prioritized`, not `waiting`.
        return await q.count();
    } catch (e) {
        errorLogger.error(
            '[matching] no se pudo leer el tamaño de la cola:',
            (e as Error)?.message
        );
        return null;
    }
};

// ---- invalidation ----

/** Deletes cache entries involving `bondId` (as source or participant).
 *  Returns the affected `sourceBond` ids, for fresh recomputes. */
export const invalidateBondMatches = async (
    bondId: string
): Promise<string[]> => {
    const oid = new mongoose.Types.ObjectId(bondId);
    const affected = (await BondMatch.distinct('sourceBond', {
        bonds: oid,
    })) as any[];
    const affectedIds = affected
        .map((a) => a.toString())
        .filter((id) => id !== bondId.toString());
    await BondMatch.deleteMany({ sourceBond: { $in: [oid, ...affected] } });

    // Read model: delete exactly the rows mentioning the bond (it is no longer
    // valid for anyone) and re-enqueue their owners; other rows are left alone.
    if (MATCHING.feedWrite) {
        const readers = (await BondMatchFeed.distinct('bond', {
            bonds: oid,
        })) as any[];
        await BondMatchFeed.deleteMany({ bonds: oid });
        for (const r of readers) {
            const id = r.toString();
            if (id !== bondId.toString()) affectedIds.push(id);
        }
    }

    return [...new Set(affectedIds)];
};

/** Invalidates the caches touching `bondId` and re-enqueues recomputes.
 *  `active`: whether the bond itself is still active (also recomputed). */
export const invalidateAndRefresh = async (
    bondId: string,
    active: boolean
): Promise<void> => {
    try {
        const affected = await invalidateBondMatches(bondId);

        // CRITICAL: deleting BondMatch rows is not enough. The sweep selects on the
        // agenda, so a recent timestamp makes it skip these bonds and serving returns
        // a false 0 until the TTL (~60 min). Clear `matchesComputedAt` and
        // `matchesNextAt` on the bond AND every affected bond: they become immediately
        // eligible and serving sees 'computing' (re-enqueue), not 'ready 0'.
        // Excluding the bond itself here caused a real 'ready 0' regression on
        // link and pause+reactivation.
        const toClear = [bondId, ...affected].map(
            (id) => new mongoose.Types.ObjectId(id)
        );
        // `$inc: matchesGen` closes the race with an in-flight compute: BullMQ drops
        // the re-enqueue (jobId `rc-B` busy), the stale compute would persist old data
        // and seal B for 24h. A bumped generation makes it skip the seal, so the
        // sweep retakes B.
        await BondRequest.updateMany(
            { _id: { $in: toClear } },
            {
                $set: { matchesNextAt: agendaVencida() },
                $inc: { matchesGen: 1 },
                $unset: { matchesComputedAt: '' },
            },
            // `timestamps: false`: this is bookkeeping, not a bond change. Without
            // it, updating thousands of sourceBonds moves `updatedAt`, which feeds
            // freshnessFactor (10% of the score).
            { timestamps: false }
        );

        // Fan-out cap: invalidating a popular bond can touch thousands of
        // sourceBonds, and enqueueing them all triggers an O(N^2) avalanche. Enqueue
        // only the first N; the rest are deferred to the sweep, which picks them up
        // because their cache/agenda were cleared above. The active bond itself is
        // always enqueued (below) and does not count against the cap.
        const cap = MATCHING.invalidationFanout;
        const toEnqueue =
            affected.length > cap ? affected.slice(0, cap) : affected;
        if (affected.length > cap) {
            logger.warn(
                `[matching] invalidateAndRefresh: fan-out ${affected.length} > cap ${cap}; ` +
                    `encolando ${cap}, difiriendo ${affected.length - cap} al sweep.`
            );
        }
        toEnqueue.forEach((id) => enqueueRecompute(id));
        if (active) enqueueRecompute(bondId, MATCH_PRIORITY_USER);
    } catch (e) {
        errorLogger.error(
            '[matching] invalidateAndRefresh fallo:',
            (e as Error)?.message
        );
    }
};

// ---- worker / lifecycle ----

let worker: Worker | undefined;

/** Starts the BullMQ worker if Redis is configured; otherwise keeps fallback mode. */
export const startMatchingWorker = (): void => {
    // Only the worker process (worker.ts) calls this; it enables inline compute
    // here, never in the API, so the API event loop stays protected.
    INLINE_ENABLED = true;
    const opts = getConnectionOptions();
    if (!opts) {
        logger.info(
            '[matching] sin REDIS_URL: robot en modo fallback (compute-on-miss + inline).'
        );
        return;
    }
    if (worker) return;
    // The Worker uses blocking commands (BZPOPMIN) that monopolize its connection.
    // Passing OPTIONS (not a shared client) gives it a dedicated connection separate
    // from the Queue, so `queue.add()` is never stuck behind the worker.
    // `concurrency` is per-process; real parallelism needs more worker instances
    // (raise `instances` in PM2) and BullMQ splits the jobs among them.
    const concurrency = Number(process.env.MATCH_WORKER_CONCURRENCY) || 4;
    // `lockDuration`: job lock TTL in Redis. The renewer runs every lockDuration/4,
    // so a job tolerates blocking the loop for up to ~lockDuration/2 (~60 s here;
    // 15 s with the 30 s default, which sync computes at concurrency 4 over ~440
    // candidates can exceed). Env MATCH_LOCK_DURATION_MS, clamped in matching.config.ts.
    const lockDuration = MATCHING.lockDurationMs;
    // Instrument T (event-loop time per recompute) for the capacity math: loop
    // utilization over the minute divided by finished recomputes — an upper bound,
    // since sweeps share the loop. At most one log line per minute.
    const minuto = { n: 0, pared: 0, max: 0 };
    let elu = performance.eventLoopUtilization();
    setInterval(() => {
        const ahora = performance.eventLoopUtilization();
        const d = performance.eventLoopUtilization(ahora, elu);
        elu = ahora;
        if (minuto.n > 0) {
            logger.info(
                `[matching] recómputos en ${Math.round((d.idle + d.active) / 1000)} s: ${minuto.n} · pared media ${Math.round(minuto.pared / minuto.n)} ms, máx ${minuto.max} ms · event loop ${Math.round(d.utilization * 100)}% ocupado → T ≤ ${Math.round(d.active / minuto.n)} ms`
            );
        }
        minuto.n = minuto.pared = minuto.max = 0;
    }, 60000).unref();
    worker = new Worker(
        QUEUE_NAME,
        async (job: Job) => {
            if (job.name === 'recompute') {
                const t0 = Date.now();
                try {
                    await recomputeBond(job.data.bondId);
                } finally {
                    const ms = Date.now() - t0;
                    minuto.n++;
                    minuto.pared += ms;
                    if (ms > minuto.max) minuto.max = ms;
                }
            }
        },
        { connection: opts as any, concurrency, lockDuration }
    );
    // Without this listener, Worker errors went through console.error (PM2 log,
    // untagged, outside winston) and Redis connection errors went nowhere: the
    // matcher went mute. "could not renew lock" also lands here — that job will stall.
    worker.on('error', (err: Error) => {
        errorLogger.error('[matching] worker BullMQ:', err?.message);
    });
    // A job whose lock expired (loop blocked too long, or its worker died) returns
    // to the queue; this line should NEVER appear — if it does, check lockDuration.
    worker.on('stalled', (jobId: string) => {
        errorLogger.error(
            `[matching] job ${jobId} stalleado: su lock venció, vuelve a la cola`
        );
    });
    worker.on('failed', (job: Job | undefined, err: Error) => {
        errorLogger.error(`[matching] job ${job?.id} fallo:`, err?.message);

        // ANTI-STARVATION (panel 11/9). `removeOnFail: true` frees the jobId, but it
        // also removes an accidental brake: a bond that always fails would otherwise
        // keep the epoch sentinel, sort first and be re-enqueued by the sweep ahead of
        // every healthy bond, 12 times an hour, forever. With enough broken bonds the
        // whole batch is wasted. On exhausted retries we push its agenda forward —
        // still eligible, just at the back of the queue.
        // Two paths reach 'failed': normal retries (attemptsMade 3) and a job stalled
        // past maxStalledCount (UnrecoverableError, attemptsMade 1) — the likelier
        // case here, since sync computes can block the loop past the lock.
        const agotoIntentos =
            !!job &&
            (job.attemptsMade >= (job.opts?.attempts ?? 1) ||
                (err as Error)?.name === 'UnrecoverableError');
        const bondId = job?.data?.bondId;
        if (!agotoIntentos || !bondId) return;

        BondRequest.updateOne(
            { _id: bondId },
            {
                $set: {
                    matchesNextAt: new Date(
                        Date.now() + AGENDA.ttlFrioMin * 60 * 1000
                    ),
                },
            },
            // No timestamps: `updatedAt` feeds freshnessFactor (part of the score);
            // a failure must not change ranking.
            { timestamps: false }
        ).catch((e: any) =>
            errorLogger.error(
                '[matching] no se pudo diferir la agenda del job fallido:',
                e?.message
            )
        );
    });
    logger.info(
        `[matching] worker BullMQ activo (concurrency ${concurrency}, lock ${lockDuration} ms).`
    );
};

/** Graceful shutdown. BullMQ owns the ioredis clients (built from the options),
 *  so `close()` also closes the connections. */
export const closeMatchingRobot = async (): Promise<void> => {
    try {
        if (worker) await worker.close();
        if (queue) await queue.close();
    } catch {
        /* noop */
    }
};

export { recomputeBond };
