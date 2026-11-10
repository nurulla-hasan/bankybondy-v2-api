/* Idempotent migration: adds `applied:true` to ratings created before the field existed
 * (they would stop counting) and recomputes affected reputations. Safe to re-run. */
import BondRating from './bondRating.model';
import { recomputeReputation } from './reputation.util';
import { logger } from '../../shared/logger';

export const applyExistingRatings = async (): Promise<void> => {
    // Only ratings from before this feature (no `applied` field).
    const pending: any[] = await BondRating.find({
        applied: { $exists: false },
    })
        .select('rated')
        .lean();
    if (!pending.length) return;

    await BondRating.updateMany(
        { applied: { $exists: false } },
        { $set: { applied: true } }
    );

    const ratedIds = [
        ...new Set(
            pending.map((r) => r.rated?.toString()).filter(Boolean)
        ),
    ];
    for (const rid of ratedIds) {
        // eslint-disable-next-line no-await-in-loop
        await recomputeReputation(rid).catch(() => undefined);
    }

    logger.info(
        `[migración] applyExistingRatings: ${pending.length} calificación(es) marcadas applied + ${ratedIds.length} reputación(es) recalculadas.`
    );
};

export default applyExistingRatings;
