/* E1: recomputo periódico del "trending" (lo que sube). Recalcula `trendingScore`
 * de los audios `ready` a partir de señales REALES:
 *   - escuchas calificadas + completion promedio (eventos AudioListen, de E0)
 *   - guardados (AudioBookmark) — señal costosa
 *   - frescura (edad del audio) — oxigena lo nuevo
 * La fórmula vive en audio.trending.ts (pura/testeable). Corre en el worker (cron).
 *
 * Se recomputa TODO lo visible en cada corrida (no solo lo que tuvo escuchas nuevas)
 * porque la frescura decae con la edad → el score de un audio baja aunque no cambie
 * su engagement. Escala con la cantidad de audios `ready`; si crece mucho, conviene
 * pasar a un pipeline de agregación con $merge (nota para el 2º tramo de E1).
 */
import cron from 'node-cron';
import { expresionCron } from '../../utilities/expresionCron';
import { errorLogger, logger } from '../../shared/logger';
import Audio, { AudioListen } from './audio.model';
import AudioBookmark from '../audioBookmark/audio.bookmark.model';
import { ENUM_AUDIO_MODERATION_STATUS } from './audio.interface';
import { computeTrendingScore } from './audio.trending';

const CRON = expresionCron('TRENDING_SWEEP_CRON', '*/15 * * * *'); // cada 15 min
const ENABLED = process.env.TRENDING_SWEEP_ENABLED !== 'false';

export const runTrendingRecomputeOnce = async (): Promise<number> => {
    // 1) Señales de escucha por audio (todas las de E0).
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

    // 2) Guardados por audio, pero SOLO los de gente que ADEMÁS escuchó calificado
    // ese audio → el bookmark vuelve a ser "escuchó Y guardó" (señal costosa de
    // verdad) y no un tap barato de brigadeo. Excluye al dueño de yapa: no puede
    // escuchar su propio audio (recordListen lo descarta) → no tiene AudioListen →
    // su guardado no cuenta. Cierra el auto-inflado y el vector de brigadeo.
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

    // 3) Recalcular el score de cada audio visible.
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
// Anti-solape: si una corrida se demora más que el intervalo, no arrancar otra.
let running = false;
/** Registra el cron del recomputo de trending (idempotente). Llamar al arrancar. */
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
