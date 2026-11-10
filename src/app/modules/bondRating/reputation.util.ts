import mongoose, { ClientSession } from 'mongoose';
import NormalUser from '../normalUser/normalUser.model';
import { bayesianReputation } from '../bondRequest/matching.scoring';
import BondRating from './bondRating.model';

/**
 * Recomputes and caches a user's reputation from their BondRatings.
 * `session` is needed by the cascade delete, which bypasses model hooks.
 */
export const recomputeReputation = async (
    ratedUserId: string,
    session?: ClientSession
): Promise<void> => {
    const aggQuery = BondRating.aggregate([
        // Only applied ratings count (pending until the trade closes).
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
