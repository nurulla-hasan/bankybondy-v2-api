/* eslint-disable @typescript-eslint/no-explicit-any */
/* Attachment gallery pipeline for a conversation (PURE: testable without a DB,
 * like message.pipeline.ts).
 *
 * `urls` stays a flat string array (app v1 reads it as-is), but a string cannot
 * say which message it came from, so grouping by day or jumping to the message
 * was impossible. Hence `items` carries the back-reference, and `urls` is
 * DERIVED from `items` so the two cannot diverge.
 */

export type MediaKind = 'image' | 'video' | 'pdf';

export type MediaItem = {
    url: string;
    kind: MediaKind;
    messageId: unknown;
    createdAt: unknown;
};

const KIND_BY_FIELD: Array<{ field: string; kind: MediaKind }> = [
    { field: 'imageUrl', kind: 'image' },
    { field: 'videoUrl', kind: 'video' },
    { field: 'pdfUrl', kind: 'pdf' },
];

export const buildMediaGalleryPipeline = ({
    conversationObjectId,
    blockedObjectIds,
    skip,
    limit,
}: {
    conversationObjectId: any;
    blockedObjectIds: any[];
    skip: number;
    limit: number;
}): any[] => [
    {
        $match: {
            conversationId: conversationObjectId,
            // The gallery must not show attachments from DELETED messages nor
            // BLOCKED users: matching by conversation alone was not enough.
            isDeleted: { $ne: true },
            msgByUserId: { $nin: blockedObjectIds },
        },
    },
    {
        $project: {
            createdAt: 1,
            media: {
                $concatArrays: KIND_BY_FIELD.map(({ field, kind }) => ({
                    $map: {
                        input: { $ifNull: [`$${field}`, []] },
                        as: 'url',
                        in: { url: '$$url', kind },
                    },
                })),
            },
        },
    },
    { $unwind: '$media' },
    {
        $facet: {
            paginatedResults: [
                { $sort: { _id: 1 } },
                { $skip: skip },
                { $limit: limit },
                {
                    $group: {
                        _id: null,
                        items: {
                            $push: {
                                $mergeObjects: [
                                    '$media',
                                    { messageId: '$_id', createdAt: '$createdAt' },
                                ],
                            },
                        },
                    },
                },
            ],
            totalCount: [{ $count: 'count' }],
        },
    },
];

// The only source of `urls`: derived, not recomputed by another path.
export const urlsFromItems = (items: MediaItem[]): string[] =>
    (items ?? []).map((item) => item.url);
