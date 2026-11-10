/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import mongoose from 'mongoose';
import AppError from '../../error/appError';
import { BondLink } from '../bondLink/bondLink.model';
import { ENUM_BOND_LINK_STATUS } from '../bondLink/bondLink.enum';
import NormalUser from '../normalUser/normalUser.model';
import { IBondRating } from './bondRating.interface';
import BondRating from './bondRating.model';
import { bayesianReputation } from '../bondRequest/matching.scoring';
import sendNotification from '../../helper/sendNotification';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';
import { clampLimit, clampPage } from '../../utilities/pagination';
import { getBlockedObjectIdsFor } from '../userBlock/userBlock.service';

const addRating = async (
    profileId: string,
    payload: IBondRating & { userId: string }
) => {
    // Anti self-rating: you could otherwise rate yourself 5 stars and inflate
    // the reputation that drives matching and People ordering.
    if (String(payload.userId) === String(profileId)) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'No podés calificarte a vos mismo'
        );
    }

    const bondLink = await BondLink.findOne({
        _id: payload.bondLink,
        participants: new mongoose.Types.ObjectId(profileId),
    }).populate({ path: 'requestedBonds' });

    if (!bondLink) {
        throw new AppError(httpStatus.NOT_FOUND, 'Bond link not found');
    }

    // You must have marked YOURSELF as completed to rate. Requiring the whole
    // link to be Completed blocked the first participant from rating at all.
    // The strong guard is the own signature only.
    const marcasteCompletado = (bondLink.markAsCompletedBy ?? []).some(
        (x: any) => x?.toString() === profileId.toString()
    );
    if (!marcasteCompletado) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Para calificar tenés que marcar el trueque como completado.'
        );
    }
    // `requestedBonds` may contain null if a referenced bond was deleted by its
    // owner, so `bond.user` crashed. Optional chaining is defensive; bondLink is
    // checked first.
    const ratedUserBondRequest: any = bondLink.requestedBonds.find(
        (bond: any) => bond?.user?.toString() == payload.userId
    );

    if (!ratedUserBondRequest) {
        throw new AppError(
            httpStatus.NOT_FOUND,
            'Rated user bond request not found'
        );
    }

    // Create or UPDATE the rating of the same (ratedBy, rated, bondLink) pair;
    // the upsert makes editing idempotent.
    try {
        const result = await BondRating.findOneAndUpdate(
            {
                rated: payload.userId,
                ratedBy: profileId,
                bondLink: payload.bondLink,
            },
            {
                $set: {
                    rated: payload.userId,
                    ratedBy: profileId,
                    bondLink: payload.bondLink,
                    want: ratedUserBondRequest.want,
                    offer: ratedUserBondRequest.offer,
                    rating: payload.rating,
                    // Suspended rating: only counts once the trade is closed;
                    // otherwise it is applied in batch when everyone completes.
                    applied:
                        bondLink.status === ENUM_BOND_LINK_STATUS.Completed,
                    // Persisted only if present in the payload; undefined does not clear.
                    ...(payload.comment !== undefined
                        ? { comment: payload.comment }
                        : {}),
                },
            },
            {
                new: true,
                upsert: true,
                runValidators: true,
                setDefaultsOnInsert: true,
            }
        );
        // The rated user's cached reputation is recomputed ONLY by the
        // BondRating post-hook 'findOneAndUpdate' (covers save/update/delete).

        // Notify the RATED user. Best-effort, does not block the response.
        // `payload.userId` = rated, `profileId` = rater (redirectId points there).
        sendNotification({
            title: 'Tenés una nueva reseña',
            message: 'Alguien contó cómo fue encontrarse con vos.',
            receiver: String(payload.userId),
            type: ENUM_NOTIFICATION_TYPE.REVIEW,
            redirectId: String(profileId),
        }).catch(() => undefined);

        return result;
    } catch (error: unknown) {
        if ((error as { code?: number })?.code === 11000) {
            throw new AppError(
                httpStatus.CONFLICT,
                'You already gave rating to that user for this bond'
            );
        }
        throw error;
    }
};

/**
 * Public view of a user's reputation: cached score plus the received ratings
 * (rater name/image and comment). Paginated.
 */
const getPublicRatings = async (
    ratedUserId: string,
    query: Record<string, unknown>,
    viewerId?: string
) => {
    if (!mongoose.Types.ObjectId.isValid(ratedUserId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid user id');
    }

    const page = clampPage(query.page);
    const limit = clampLimit(query.limit); // previously uncapped: ?limit=9999999
    const skip = (page - 1) * limit;

    const ratedId = new mongoose.Types.ObjectId(ratedUserId);

    const user = await NormalUser.findById(ratedId).select(
        'name profile_image reputation'
    );
    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    // Viewer's blocks (both directions): hide ratings by blocked users, and
    // return an empty shape if the visited profile is in a block relation.
    const blockedObjectIds = viewerId
        ? await getBlockedObjectIdsFor(viewerId)
        : [];

    const profileIsBlocked = blockedObjectIds.some(
        (id) => id.toString() === ratedUserId
    );
    if (profileIsBlocked) {
        return {
            meta: {
                page,
                limit,
                total: 0,
                totalPages: 0,
            },
            reputation: {
                avg: 0,
                count: 0,
                score: bayesianReputation(0, 0),
            },
            user: {
                _id: user._id,
                name: user.name,
                profile_image: user.profile_image,
            },
            ratings: [],
        };
    }

    const [ratings, total, agg] = await Promise.all([
        BondRating.find({ rated: ratedId, ratedBy: { $nin: blockedObjectIds }, applied: true })
            // Include the rater's `reputation` so the frontend can link to it.
            .populate({
                path: 'ratedBy',
                select: 'name profile_image reputation',
            })
            .select('rating comment want offer ratedBy createdAt')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        BondRating.countDocuments({
            rated: ratedId,
            ratedBy: { $nin: blockedObjectIds },
            applied: true,
        }),
        // Live avg/count from the real ratings so the header always matches the
        // visible reviews even when the cached reputation is stale.
        BondRating.aggregate([
            { $match: { rated: ratedId, ratedBy: { $nin: blockedObjectIds }, applied: true } },
            {
                $group: {
                    _id: '$rated',
                    avg: { $avg: '$rating' },
                    count: { $sum: 1 },
                },
            },
        ]),
    ]);

    const liveAvg = agg[0]?.avg ?? 0;
    const liveCount = agg[0]?.count ?? 0;

    return {
        meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
        // avg/count always live; score uses the same Bayesian function.
        reputation: {
            avg: liveAvg,
            count: liveCount,
            score: bayesianReputation(liveAvg, liveCount),
        },
        user: {
            _id: user._id,
            name: user.name,
            profile_image: user.profile_image,
        },
        ratings,
    };
};

const BondRatingServices = { addRating, getPublicRatings };
export default BondRatingServices;
