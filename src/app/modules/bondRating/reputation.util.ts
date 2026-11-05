import mongoose, { ClientSession } from 'mongoose';
import NormalUser from '../normalUser/normalUser.model';
import { bayesianReputation } from '../bondRequest/matching.scoring';
import BondRating from './bondRating.model';

/**
 * Recalcula y cachea la reputacion de un usuario a partir de sus BondRatings.
 *
 * `session` opcional: el borrado en cascada de una cuenta borra bondratings con el
 * driver nativo (se saltan los hooks del modelo), asi que necesita recomputar a
 * mano DENTRO de la misma transaccion — pasando la sesion, el aggregate ve el
 * estado ya-borrado y el update queda dentro del commit.
 */
export const recomputeReputation = async (
    ratedUserId: string,
    session?: ClientSession
): Promise<void> => {
    const aggQuery = BondRating.aggregate([
        // Solo las calificaciones APLICADAS cuentan (rating en suspenso: no impacta la
        // reputación hasta que el trueque cierra). Ver BondRating.applied.
        {
            $match: {
                rated: new mongoose.Types.ObjectId(ratedUserId),
                applied: true,
            },
        },
        {
            $group: {
                _id: '$rated',
                avg: { $avg: '$rating' },
                count: { $sum: 1 },
            },
        },
    ]);
    if (session) aggQuery.session(session);
    const agg = await aggQuery;

    const avg = agg[0]?.avg ?? 0;
    const count = agg[0]?.count ?? 0;
    const score = bayesianReputation(avg, count);

    await NormalUser.findByIdAndUpdate(
        ratedUserId,
        { reputation: { avg, count, score } },
        session ? { session } : {}
    );
};
