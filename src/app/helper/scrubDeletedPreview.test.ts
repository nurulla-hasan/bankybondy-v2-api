/* eslint-disable @typescript-eslint/no-explicit-any */
/* Pruebas puras de la vista previa borrada (sin DB ni red).
 * Blindan que las DOS puertas (listado de chats por HTTP y evento `conversation`
 * del socket) vacíen el mismo contenido y con las mismas claves, porque si se
 * separan, una puerta sigue filtrando el texto de un mensaje borrado. */
import mongoose from 'mongoose';
import {
    scrubLastMessageStage,
    scrubPreview,
    toPlainPreview,
} from './scrubDeletedPreview';

type Case = [name: string, cond: boolean];

const id = new mongoose.Types.ObjectId();
const conversationId = new mongoose.Types.ObjectId();
const readerId = new mongoose.Types.ObjectId();

const deleted = {
    _id: id,
    text: 'contenido que ya no existe',
    imageUrl: ['https://cdn/x.jpg'],
    videoUrl: ['https://cdn/x.mp4'],
    pdfUrl: ['https://cdn/x.pdf'],
    msgByUserId: readerId,
    seenBy: [readerId],
    conversationId,
    isDeleted: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    __v: 0,
};

const alive = { ...deleted, isDeleted: false, text: 'hola' };

const CONTENT_KEYS = ['text', 'imageUrl', 'videoUrl', 'pdfUrl'];
const stage = scrubLastMessageStage().$addFields.lastMessage.$cond;
const scrubbedStageDoc = stage.then;

const cases: Case[] = [
    // — puerta socket (función JS) —
    ['borrado: el texto no viaja', scrubPreview(deleted).text === null],
    ['borrado: las imágenes no viajan', scrubPreview(deleted).imageUrl === null],
    ['borrado: los videos no viajan', scrubPreview(deleted).videoUrl === null],
    ['borrado: los PDF no viajan', scrubPreview(deleted).pdfUrl === null],
    ['borrado: ningún contenido conserva arrays/strings',
        CONTENT_KEYS.every((k) => scrubPreview(deleted)[k] === null)],
    ['borrado: isDeleted=true sigue viajando (el front dibuja "Mensaje borrado")',
        scrubPreview(deleted).isDeleted === true],
    ['borrado: _id, conversationId, msgByUserId y fechas siguen viajando',
        scrubPreview(deleted)._id === id &&
        scrubPreview(deleted).conversationId === conversationId &&
        scrubPreview(deleted).msgByUserId === readerId &&
        scrubPreview(deleted).createdAt === deleted.createdAt &&
        scrubPreview(deleted).updatedAt === deleted.updatedAt],
    ['borrado: seenBy NO viaja (nombra a quien leyó) y __v tampoco',
        !('seenBy' in scrubPreview(deleted)) && !('__v' in scrubPreview(deleted))],
    ['no borrado: intacto, misma referencia (cero reshaping)',
        scrubPreview(alive) === alive],
    ['sin último mensaje: null sigue siendo null (chats recién creados)',
        scrubPreview(null) === null && scrubPreview(undefined) === undefined],

    // — puerta HTTP (etapa de agregación) —
    ['la etapa corta por isDeleted, no por otra cosa',
        JSON.stringify(stage.if) === JSON.stringify({ $eq: ['$lastMessage.isDeleted', true] })],
    ['la etapa vacía los cuatro contenidos',
        CONTENT_KEYS.every((k) => scrubbedStageDoc[k] === null)],
    ['la etapa conserva las claves visibles',
        scrubbedStageDoc._id === '$lastMessage._id' &&
        scrubbedStageDoc.conversationId === '$lastMessage.conversationId' &&
        scrubbedStageDoc.msgByUserId === '$lastMessage.msgByUserId' &&
        scrubbedStageDoc.createdAt === '$lastMessage.createdAt' &&
        scrubbedStageDoc.updatedAt === '$lastMessage.updatedAt' &&
        scrubbedStageDoc.isDeleted === true],
    ['la etapa NO devuelve seenBy ni __v',
        !('seenBy' in scrubbedStageDoc) && !('__v' in scrubbedStageDoc)],
    ['la etapa deja intacto lo no borrado (rama else)', stage.else === '$lastMessage'],

    // — las dos puertas no pueden divergir —
    ['listado de claves idéntico en la etapa y en la función',
        JSON.stringify(Object.keys(scrubbedStageDoc).sort()) ===
            JSON.stringify(Object.keys(scrubPreview(deleted)).sort())],

    // — helper de populates —
    ['documento mongoose populado se vuelve plano antes de vaciar',
        toPlainPreview({ toObject: () => alive }) === alive],
    ['objeto plano pasa como está', toPlainPreview(deleted) === deleted],
    ['null/undefined → null (no revienta el emisor del socket)',
        toPlainPreview(null) === null && toPlainPreview(undefined) === null],
];

export const runScrubDeletedPreviewTests = (): { pass: number; fail: number } => {
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
