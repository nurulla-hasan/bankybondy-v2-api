/*
 * Las etapas de agregación de `getMessages`, separadas del service para que sus
 * reglas silenciosas se puedan probar sin base de datos ni red:
 *
 *  - `seen` se deriva de `seenBy` (y `seenBy` NO viaja al cliente: nombra a
 *    todos los lectores de un mensaje, es una fuga aparte),
 *  - el contenido de un mensaje borrado sigue anulado por `$cond`,
 *  - el bloqueo se aplica por autor, no por conversación.
 *
 * Cambiar el orden o las claves de estas etapas rompe contrato con clientes que
 * no podemos inspeccionar (v1 y la app nativa), así que lo que antes era un
 * literal inlineado sin test es ahora un módulo con test.
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
            // Antes era `seen: 1` en la proyección: un campo que NO existe en el
            // schema, así que nunca aparecía en la respuesta. Se calcula acá
            // porque `$project` no puede leer `seenBy` y a la vez ocultarlo.
            seen: {
                $in: [requesterObjectId, { $ifNull: ['$seenBy', []] }],
            },
        },
    },
    {
        // M2: un mensaje BORRADO (isDeleted) no debe viajar con su contenido en
        // el payload. Antes se devolvía text/imageUrl/videoUrl/pdfUrl igual y el
        // front solo lo ocultaba, pero la data seguía en la respuesta de red.
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
