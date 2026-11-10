/*
 * Aggregation stages of `getMessages`, split out so their silent rules are
 * testable: `seen` derives from `seenBy` (never sent), deleted content is nulled
 * by `$cond`, blocking applies per author. Order and keys are a client contract.
 */
import type { Types } from 'mongoose';
import { escapeRegex } from '../../utilities/escapeRegex';

export const buildMessagesPipeline = ({
    conversationObjectId,
    requesterObjectId,
    searchTerm,
    skip,
    limit,
    blockedObjectIds,
}: {
    conversationObjectId: Types.ObjectId;
    requesterObjectId: Types.ObjectId;
    searchTerm: string;
    skip: number;
    limit: number;
    blockedObjectIds: unknown[];
}): any[] => [
    {
        $match: {
            conversationId: conversationObjectId,
            text: { $regex: escapeRegex(searchTerm), $options: 'i' },
            msgByUserId: { $nin: blockedObjectIds },
        },
    },
    {
        $lookup: {
            from: 'normalusers',
            localField: 'msgByUserId',
            foreignField: '_id',
            as: 'userDetails',
        },
    },
    { $unwind: '$userDetails' },
    {
        $addFields: {
            isMyMessage: { $eq: ['$msgByUserId', requesterObjectId] },
            // Computed here because `$project` cannot read `seenBy` and hide it.
            seen: {
                $in: [requesterObjectId, { $ifNull: ['$seenBy', []] }],
            },
        },
    },
    {
        // A deleted message must not ship its content in the payload.
        $project: {
            text: { $cond: ['$isDeleted', null, '$text'] },
            imageUrl: { $cond: ['$isDeleted', null, '$imageUrl'] },
            videoUrl: { $cond: ['$isDeleted', null, '$videoUrl'] },
            pdfUrl: { $cond: ['$isDeleted', null, '$pdfUrl'] },
            seen: 1,
            msgByUserId: 1,
            conversationId: 1,
            createdAt: 1,
            updatedAt: 1,
            isDeleted: 1,
            'userDetails.name': 1,
            'userDetails.profile_image': 1,
            isMyMessage: 1,
        },
    },
    { $sort: { createdAt: -1 } },
    {
        $facet: {
            result: [{ $skip: skip }, { $limit: limit }],
            totalCount: [{ $count: 'total' }],
        },
    },
];
