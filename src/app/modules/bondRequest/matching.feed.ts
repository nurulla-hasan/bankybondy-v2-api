/* Read model del matcheo: filas por PARTICIPANTE.
 *
 * BondMatch (write model) guarda un trato UNA vez, bajo el bond que lo descubrió.
 * Para servir "mis matches" eso obliga a leer el superset `{ bonds: id }` de toda
 * la colección y ordenarlo en memoria: miles de documentos por request.
 *
 * Acá se fan-out el mismo trato a cada participante, con `matchKey` (la firma
 * ordenada de ids que ya usan las notificaciones) como clave de dedup. El serving
 * queda acotado y ordenado por índice:
 *
 *   BondMatchFeed.find({ bond }).sort({ score: -1 }).limit(feedScanLimit)
 *
 * NO toca scoring, candidatos, ciclos ni ranking: sólo dónde y cómo se lee.
 */
import mongoose from 'mongoose';
import BondMatchFeed from '../bondMatch/bondMatchFeed.model';
import { IBondMatchFeed } from '../bondMatch/bondMatchFeed.interface';
import { MATCHING } from './matching.config';
import type { MatchRecord } from './matching.compute';

/** Firma canónica de un trato: ids ordenados y unidos por '|'.
 *  Es EXACTAMENTE la misma que usa notifyNewMatches, para que write/serve/notify
 *  no puedan divergir en qué consideran "el mismo match". */
export const buildMatchKey = (
    ids: Array<string | mongoose.Types.ObjectId>
): string =>
    [...ids]
        .map((id) => id.toString())
        .sort()
        .join('|');

/** Score de ranking del serving: `pairBias` es una preferencia SUAVE por
 *  cadenas cortas (size 2 = 0; 3 = -pairBias; ...), no un dictador. */
export const rankScoreOf = (
    score: number,
    size: number,
    legacy = MATCHING.legacyRanking
): number => score - (legacy ? 0 : MATCHING.pairBias * (size - 2));

export type FeedDoc = IBondMatchFeed;

/** Expande UN trato en una fila por participante (sin duplicar ids). */
export const recordToFeedDocs = (
    record: MatchRecord,
    sourceBondId: string,
    now: Date = new Date()
): FeedDoc[] => {
    const matchKey = buildMatchKey(record.ids);
    const sourceBond = new mongoose.Types.ObjectId(sourceBondId);
    const bonds = record.ids.map((id) => new mongoose.Types.ObjectId(id));
    const users = record.users.map((id) => new mongoose.Types.ObjectId(id));

    const seen = new Set<string>();
    const docs: FeedDoc[] = [];
    for (const raw of record.ids) {
        const id = raw.toString();
        if (seen.has(id)) continue;
        seen.add(id);
        docs.push({
            bond: new mongoose.Types.ObjectId(id),
            matchKey,
            bonds,
            users,
            score: record.score,
            parts: record.parts,
            type: record.type,
            size: record.size,
            sourceBond,
            computedAt: now,
        });
    }
    return docs;
};

/** Claves de las N mejores filas por score (para shadow/verificación). */
export const topMatchKeys = (
    rows: Array<{ matchKey?: string; bonds?: unknown[]; score: number }>,
    n: number
): string[] =>
    [...rows]
        .sort((a, b) => b.score - a.score)
        .slice(0, n)
        .map((r) =>
            r.matchKey ??
            buildMatchKey((r.bonds ?? []) as Array<string | mongoose.Types.ObjectId>)
        );

/** Poda un participante para que su feed nunca crezca sin límite.
 *  Conserva las `feedMaxRowsPerBond` mejores por score y borra TODO el resto.
 *  El bucle no tiene un tope fijo de pasadas: un bond denso (miles de filas)
 *  quedaría con "top-N + cola" si cortáramos antes de vaciar el excedente. */
export const trimFeedBond = async (
    bond: mongoose.Types.ObjectId | string
): Promise<number> => {
    const bondId =
        typeof bond === 'string' ? new mongoose.Types.ObjectId(bond) : bond;
    let deleted = 0;
    for (let pass = 0; pass < 1000; pass++) {
        const extra = await BondMatchFeed.find({ bond: bondId })
            .sort({ score: -1, _id: 1 })
            .skip(MATCHING.feedMaxRowsPerBond)
            .limit(1000)
            .select('_id')
            .lean();
        if (!extra.length) break;
        const res = await BondMatchFeed.deleteMany({
            _id: { $in: extra.map((e) => e._id) },
        });
        const n = res.deletedCount ?? 0;
        deleted += n;
        // Si no se borró nada, seguir iterando no cambia el estado.
        if (n === 0) break;
    }
    return deleted;
};

/** Update de upsert que conserva el MEJOR score cuando el mismo trato llega
 *  desde dos discoverers (o desde una fila legacy vieja). El serving legacy
 *  deduplica por conjunto quedándose con el mayor score; el feed debe hacer lo
 *  mismo para no servir un match "degradado" por una fila histórica. */
const feedUpsertUpdate = (doc: FeedDoc) => {
    const mejor = { $gt: [doc.score, { $ifNull: ['$score', -1] }] };
    return [
        {
            $set: {
                bonds: doc.bonds,
                users: doc.users,
                type: doc.type,
                size: doc.size,
                sourceBond: doc.sourceBond,
                computedAt: doc.computedAt,
                score: { $cond: [mejor, doc.score, '$score'] },
                parts: { $cond: [mejor, doc.parts, '$parts'] },
            },
        },
    ];
};

export interface PersistFeedStats {
    upserts: number;
    removed: number;
    trimmed: number;
}

/**
 * Upsert idempotente del set fresco de un discoverer.
 *
 * - Escribe una fila por participante con `{ bond, matchKey }`.
 * - Borra ÚNICAMENTE las filas que ESTE bond había descubierto y ya no encuentra
 *   (bond = sourceBond), sin tocar las que aportaron otros discoverers.
 * - Poda a cada participante para que un bond denso no vuelva a acumular miles
 *   de filas (el problema que este modelo vino a cerrar).
 */
export const persistMatchFeed = async (
    sourceBondId: string,
    records: MatchRecord[]
): Promise<PersistFeedStats> => {
    const now = new Date();
    const sourceBond = new mongoose.Types.ObjectId(sourceBondId);
    const keys = new Set<string>();
    const participants = new Map<string, mongoose.Types.ObjectId>();

    const ops: Parameters<typeof BondMatchFeed.bulkWrite>[0] = [];
    for (const record of records) {
        keys.add(buildMatchKey(record.ids));
        for (const doc of recordToFeedDocs(record, sourceBondId, now)) {
            const bondId = doc.bond.toString();
            participants.set(bondId, doc.bond);
            ops.push({
                updateOne: {
                    filter: { bond: doc.bond, matchKey: doc.matchKey },
                    // Pipeline (no $set plano): conserva el mejor score/parts si
                    // el mismo trato ya existe por otro discoverer.
                    update: feedUpsertUpdate(doc) as any,
                    upsert: true,
                },
            });
        }
    }

    let upserts = 0;
    if (ops.length) {
        const res = await BondMatchFeed.bulkWrite(ops, { ordered: false });
        upserts =
            (res.upsertedCount ?? 0) +
            (res.modifiedCount ?? 0) +
            (res.matchedCount ?? 0);
    }

    const removedRes = await BondMatchFeed.deleteMany({
        bond: sourceBond,
        sourceBond,
        matchKey: { $nin: [...keys] },
    });

    // Un trim por participante, pero en tandas: secuencialmente eran decenas de
    // round-trips por recompute; en paralelo sin límite, picos de pool.
    const TRIM_CONCURRENCY = 8;
    let trimmed = 0;
    const ids = [...participants.values()];
    for (let i = 0; i < ids.length; i += TRIM_CONCURRENCY) {
        const batch = ids.slice(i, i + TRIM_CONCURRENCY);
        const results = await Promise.all(batch.map((id) => trimFeedBond(id)));
        for (const n of results) trimmed += n;
    }

    return {
        upserts,
        removed: removedRes.deletedCount ?? 0,
        trimmed,
    };
};