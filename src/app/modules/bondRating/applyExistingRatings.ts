/* Migración idempotente: antes del "rating en suspenso" (Tanda 2), TODA calificación
 * impactaba la reputación al instante. Al agregar `applied` (default false), las
 * calificaciones VIEJAS (sin el campo) quedarían sin contar → reputaciones a 0. Esto
 * marca `applied:true` a las de antes de la feature y recalcula las reputaciones
 * afectadas, para no regresar nada. Fire-and-forget; correrla N veces no cambia nada. */
import BondRating from './bondRating.model';
import { recomputeReputation } from './reputation.util';
import { logger } from '../../shared/logger';

export const applyExistingRatings = async (): Promise<void> => {
    // Solo las que NO tienen `applied` (creadas antes de esta feature).
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
