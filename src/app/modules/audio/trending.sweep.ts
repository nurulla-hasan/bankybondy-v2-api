/* E1: periodic "trending" recompute. Recalculates `trendingScore` of `ready`
 * audios from real signals: qualified listens + completion, bookmarks, freshness.
 * The formula lives in audio.trending.ts (pure/testable); this runs in the worker.
 * Everything visible is recomputed because freshness decays with age.
 */
import cron from 'node-cron';
import { expresionCron } from '../../utilities/expresionCron';
import { errorLogger, logger } from '../../shared/logger';
import Audio, { AudioListen } from './audio.model';
import AudioBookmark from '../audioBookmark/audio.bookmark.model';
import { ENUM_AUDIO_MODERATION_STATUS } from './audio.interface';
import { computeTrendingScore } from './audio.trending';

const CRON = expresionCron('TRENDING_SWEEP_CRON', '*/15 * * * *'); // every 15 min
const ENABLED = process.env.TRENDING_SWEEP_ENABLED !== 'false';

export const runTrendingRecomputeOnce = async (): Promise<number> => {
    // 1) Listen signals per audio.
    const listenAgg = await AudioListen.aggregate(
        [
            {
                $group: {
                    _id: '$audio',
                    listens: { $sum: 1 },
                    avgCompletion: { $avg: '$completion' },
                },
            },
        ],
        { allowDiskUse: true }
    );
    const listenMap = new Map<
        string,
        { listens: number; avgCompletion: number }
    >();
    for (const r of listenAgg) {
        listenMap.set(String(r._id), {
            listens: r.listens || 0,
            avgCompletion: r.avgCompletion || 0,
        });
    }

    // 2) Bookmarks only from users who also listened to that audio: a genuinely
    // costly signal. The owner can't listen to their own audio, so self-inflation
    // and brigading don't count.
    const bmAgg = await AudioBookmark.aggregate(
        [
            {
                $lookup: {
                    from: AudioListen.collection.name,
                    let: { a: '$audio', u: '$user' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$audio', '$$a'] },
                                        { $eq: ['$listener', '$$u'] },
                                    ],
                                },
                            },
                        },
                        { $limit: 1 },
                    ],
                    as: 'listened',
                },
            },
            { $match: { 'listened.0': { $exists: true } } },
            { $group: { _id: '$audio', bookmarks: { $sum: 1 } } },
        ],
        { allowDiskUse: true }
    );
    const bmMap = new Map<string, number>();
    for (const r of bmAgg) bmMap.set(String(r._id), r.bookmarks || 0);

    // 3) Recompute the score of every visible audio.
    const audios = await Audio.find({
        moderationStatus: ENUM_AUDIO_MODERATION_STATUS.READY,
        isBlocked: false,
    })
        .select('_id createdAt')
        .lean();

    const now = Date.now();
    const ops = audios.map((a: any) => {
        const id = String(a._id);
        const l = listenMap.get(id);
        const ageHours = (now - new Date(a.createdAt).getTime()) / 3_600_000;
        const score = computeTrendingScore({
            listens: l?.listens || 0,
            avgCompletion: l?.avgCompletion || 0,
            bookmarks: bmMap.get(id) || 0,
            ageHours,
        });
        return {
            updateOne: {
                filter: { _id: a._id },
                update: { $set: { trendingScore: score } },
            },
        };
    });

    if (ops.length) await Audio.bulkWrite(ops, { ordered: false });
    return ops.length;
};

let scheduled = false;
// Anti-overlap: skip a run while the previous one is still going.
let running = false;
/** Registers the trending cron (idempotent). Call at startup. */
export const startTrendingSweep = (): void => {
    if (!ENABLED) {
        logger.info(
            '[trending] sweep deshabilitado (TRENDING_SWEEP_ENABLED=false).'
        );
        return;
    }
    if (scheduled) return;
    scheduled = true;
    cron.schedule(CRON, async () => {
        if (running) return;
        running = true;
        try {
            const n = await runTrendingRecomputeOnce();
            if (n) logger.info(`[trending] recomputado score de ${n} audio(s).`);
        } catch (e) {
            errorLogger.error('[trending] sweep falló:', (e as Error)?.message);
        } finally {
            running = false;
        }
    });
    logger.info(`[trending] sweep activo (${CRON}).`);
};
