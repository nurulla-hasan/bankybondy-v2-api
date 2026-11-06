/* eslint-disable @typescript-eslint/no-explicit-any */
/* Pruebas puras del pipeline de la galería (sin base de datos).
 *
 * Se blinda la FORMA de las etapas porque sus dos riesgos no dejan rastro: se
 * pierde un tipo de adjunto (la galería deja de mostrar PDFS, por ejemplo) o
 * `urls` e `items` se calculan por caminos distintos y discrepan entre sí. */
import mongoose from 'mongoose';
import {
    buildMediaGalleryPipeline,
    urlsFromItems,
    type MediaItem,
} from './media.pipeline';

const conversationObjectId = new mongoose.Types.ObjectId();
const blocked = [new mongoose.Types.ObjectId()];

const pipeline = buildMediaGalleryPipeline({
    conversationObjectId,
    blockedObjectIds: blocked,
    skip: 20,
    limit: 10,
});

// Devuelve el CONTENIDO de la etapa (`{$match: x}` → `x`), no el envoltorio.
const stage = (key: string): any =>
    pipeline.find((s) => key in s)?.[key];

const match = stage('$match');
const project = stage('$project');
const facet = stage('$facet');
const concat = project.media.$concatArrays as any[];
const paginated = facet.paginatedResults as any[];
const group = paginated.find((s) => '$group' in s)?.$group;

const items: MediaItem[] = [
    { url: 'https://cdn/a.jpg', kind: 'image', messageId: 1, createdAt: 1 },
    { url: 'https://cdn/b.mp4', kind: 'video', messageId: 2, createdAt: 2 },
    { url: 'https://cdn/c.pdf', kind: 'pdf', messageId: 3, createdAt: 3 },
];

type Case = [name: string, cond: boolean];

const cases: Case[] = [
    // — los guardas que evitan el leak —
    ['la galería excluye mensajes borrados',
        JSON.stringify(match.isDeleted) === JSON.stringify({ $ne: true })],
    ['la galería excluye a los usuarios bloqueados',
        JSON.stringify(match.msgByUserId) === JSON.stringify({ $nin: blocked })],
    ['el $match es por la conversación pedida, con el ObjectId ya construido',
        match.conversationId === conversationObjectId],

    // — los tres tipos, con su etiqueta —
    ['los tres campos de adjunto entran en el pipeline', concat.length === 3],
    ['cada array trae su kind (image / video / pdf)',
        JSON.stringify(concat.map((c) => c.$map.in.kind)) ===
            JSON.stringify(['image', 'video', 'pdf'])],
    ['los campos leídos son los del schema de Message',
        JSON.stringify(concat.map((c) => c.$map.input.$ifNull[0])) ===
            JSON.stringify(['$imageUrl', '$videoUrl', '$pdfUrl'])],
    ['cada campo usa $ifNull: un mensaje sin ese tipo de adjunto no rompe el $concatArrays',
        concat.every((c) => JSON.stringify(c.$map.input.$ifNull[1]) === JSON.stringify([]))],
    ['se desenrolla por adjunto (un mensaje con 5 fotos son 5 items)',
        stage('$unwind') === '$media'],

    // — la referencia de vuelta —
    ['la fecha del mensaje viaja (para agrupar por día)', project.createdAt === 1],
    ['cada item lleva messageId y createdAt del mensaje',
        JSON.stringify(group.items.$push.$mergeObjects[1]) ===
            JSON.stringify({ messageId: '$_id', createdAt: '$createdAt' })],
    ['el item conserva su url y su kind',
        JSON.stringify(group.items.$push.$mergeObjects[0]) === JSON.stringify('$media')],
    ['el paginado va por item, no por mensaje (un mensaje con 5 fotos ocupa 5)',
        JSON.stringify(paginated.map((s) => Object.keys(s)[0])) ===
            JSON.stringify(['$sort', '$skip', '$limit', '$group'])],
    ['skip y limit llegan al $facet',
        paginated[1].$skip === 20 && paginated[2].$limit === 10],

    // — urls derivado de items: no pueden discrepar —
    ['urls es exactamente la lista de urls de items, en orden',
        JSON.stringify(urlsFromItems(items)) ===
            JSON.stringify(['https://cdn/a.jpg', 'https://cdn/b.mp4', 'https://cdn/c.pdf'])],
    ['items vacío → urls vacío (sin adjuntos no hay 500)',
        urlsFromItems([]).length === 0],
    ['items indefinido → urls vacío', urlsFromItems(undefined as any).length === 0],
];

export const runMediaPipelineTests = (): { pass: number; fail: number } => {
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
