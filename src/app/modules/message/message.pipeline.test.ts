/* eslint-disable @typescript-eslint/no-explicit-any */
/* Pruebas puras del pipeline de `getMessages` (sin DB ni red).
 * Blindan tres reglas que se rompen en silencio si alguien reordena las etapas:
 *  1) `seen` existe como booleano por quien lee, calculado de `seenBy`;
 *  2) `seenBy` NO viaja al cliente (nombra a todos los lectores del mensaje);
 *  3) el contenido de un mensaje borrado sigue anulado en la proyección. */
import mongoose from 'mongoose';
import { buildMessagesPipeline } from './message.pipeline';

type Case = [name: string, cond: boolean];

const conversationId = new mongoose.Types.ObjectId();
const requesterId = new mongoose.Types.ObjectId();
const blockedId = new mongoose.Types.ObjectId();

const pipeline = buildMessagesPipeline({
    conversationObjectId: conversationId,
    requesterObjectId: requesterId,
    searchTerm: 'hola',
    skip: 20,
    limit: 10,
    blockedObjectIds: [blockedId],
});

const match = pipeline[0]?.$match;
const addFields = pipeline.find((s) => s.$addFields)?.$addFields;
const project = pipeline.find((s) => s.$project)?.$project;
const sort = pipeline.find((s) => s.$sort)?.$sort;
const facet = pipeline.find((s) => s.$facet)?.$facet;
const addFieldsIndex = pipeline.findIndex((s) => s.$addFields);
const projectIndex = pipeline.findIndex((s) => s.$project);

const scrubbed = (key: string) =>
    JSON.stringify(project?.[key]) ===
    JSON.stringify({ $cond: ['$isDeleted', null, `$${key}`] });

const cases: Case[] = [
    ['una sola etapa de $match, por conversación', !!match && match.conversationId === conversationId],
    ['el bloqueo se filtra por autor ($nin), no por conversación',
        JSON.stringify(match?.msgByUserId) === JSON.stringify({ $nin: [blockedId] })],
    ['la búsqueda escapa regex y es case-insensitive',
        match?.text?.$options === 'i' && match?.text?.$regex === 'hola'],
    ['caracteres especiales no se interpretan como regex',
        buildMessagesPipeline({
            conversationObjectId: conversationId,
            requesterObjectId: requesterId,
            searchTerm: 'a.*b',
            skip: 0,
            limit: 10,
            blockedObjectIds: [],
        })[0].$match.text.$regex === 'a\\.\\*b'],

    // — seen —
    ['`seen` se deriva de `seenBy` con $in',
        JSON.stringify(addFields?.seen) ===
            JSON.stringify({ $in: [requesterId, { $ifNull: ['$seenBy', []] }] })],
    ['`seen` se calcula ANTES de proyectar (si no, nunca aparece)',
        addFieldsIndex > -1 && projectIndex > addFieldsIndex],
    ['`seen` sale en la proyección', project?.seen === 1],
    ['`seenBy` NO sale en la proyección (fuga de quién leyó)',
        !('seenBy' in project) && !('userDetails.email' in project)],
    ['`isMyMessage` sigue comparando contra quien lee',
        JSON.stringify(addFields?.isMyMessage) ===
            JSON.stringify({ $eq: ['$msgByUserId', requesterId] })],

    // — borrados —
    ['texto de un mensaje borrado viaja como null', scrubbed('text')],
    ['imageUrl de un mensaje borrado viaja como null', scrubbed('imageUrl')],
    ['videoUrl de un mensaje borrado viaja como null', scrubbed('videoUrl')],
    ['pdfUrl de un mensaje borrado viaja como null', scrubbed('pdfUrl')],
    ['`isDeleted` viaja (el front dibuja "Deleted message", no un hueco)',
        project?.isDeleted === 1],

    // — contrato de lectura —
    ['`_id` sigue incluyéndose por defecto (nadie puso `_id: 0`)', project?._id !== 0],
    ['orden newest-first (el cliente invierte la página)',
        JSON.stringify(sort) === JSON.stringify({ createdAt: -1 })],
    ['paginación aplicada en $facet con skip/limit',
        JSON.stringify(facet?.result) === JSON.stringify([{ $skip: 20 }, { $limit: 10 }]) &&
        JSON.stringify(facet?.totalCount) === JSON.stringify([{ $count: 'total' }])],
    ['el key del listado sigue siendo `result` (contrato de v1 y de la app nativa)',
        Array.isArray(facet?.result) && !('data' in facet)],
    ['usuario proyectado solo con name y profile_image',
        project?.['userDetails.name'] === 1 &&
        project?.['userDetails.profile_image'] === 1],
];

export const runMessagePipelineTests = (): { pass: number; fail: number } => {
    let pass = 0,
        fail = 0;
    for (const [name, cond] of cases) {
        if (cond) pass++;
        else {
            fail++;
            // eslint-disable-next-line no-console
            console.error('FAIL:', name);
        }
    }
    return { pass, fail };
};
