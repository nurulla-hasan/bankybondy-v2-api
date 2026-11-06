/* eslint-disable @typescript-eslint/no-explicit-any */
/* Pipeline de la galería de adjuntos de una conversación (PURE: se puede probar
 * sin base de datos, como message.pipeline.ts).
 *
 * `urls` es un array plano de strings y sigue siéndolo — la app v1 lo lee tal
 * cual. Lo que no se podía hacer con ese formato: agrupar por día o tocar una
 * foto y saltar al mensaje que la subió, porque el string no dice de qué mensaje
 * salió. Por eso `items` lleva la referencia de vuelta, y `urls` se DERIVA de
 * `items` en vez de ser un segundo camino de datos: así no pueden discrepar.
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
            // La galería NO debe mostrar adjuntos de mensajes BORRADOS ni de
            // usuarios BLOQUEADOS: el $match por conversación solo no alcanzaba.
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

// El único origen de `urls`: derivado, no recalculado por otro camino.
export const urlsFromItems = (items: MediaItem[]): string[] =>
    (items ?? []).map((item) => item.url);
