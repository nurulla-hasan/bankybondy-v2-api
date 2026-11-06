/* eslint-disable @typescript-eslint/no-explicit-any */
/* Pruebas puras del validador de URLs de adjuntos (sin DB ni red).
 * Blindan el socket `send-message`: si vuelve a aceptarse una URL que no es de
 * nuestro CDN como adjunto, estas aserciones fallan y el gate corta. */
import {
    isCdnAttachmentUrl,
    filterCdnAttachmentUrls,
    partitionAttachmentUrls,
} from './attachmentUrl';

const CDN = 'd123abc.cloudfront.net'; // host del CDN inyectado (test determinista)
const ok = `https://${CDN}/uploads/images/chat_image/1699999999-foto.jpg`;
const okSigned = `https://${CDN}/uploads/videos/x.mp4?Expires=1&Signature=abc&Key-Pair-Id=K`;
const evil = 'https://evil.com/malware.pdf';

type Case = [name: string, cond: boolean];

const cases: Case[] = [
    // — Válidas del CDN —
    ['URL del CDN → válida', isCdnAttachmentUrl(ok, CDN) === true],
    ['URL firmada del CDN (con query) → válida (se ignora el query)',
        isCdnAttachmentUrl(okSigned, CDN) === true],

    // — Rechazos (el corazón del blindaje) —
    ['host ajeno (evil.com) → rechazada', isCdnAttachmentUrl(evil, CDN) === false],
    ['http (no https) mismo host → rechazada',
        isCdnAttachmentUrl(`http://${CDN}/uploads/x.jpg`, CDN) === false],
    ['subdominio trampa (cdn.evil.com) → rechazada',
        isCdnAttachmentUrl(`https://${CDN}.evil.com/x.jpg`, CDN) === false],
    ['CDN en el query pero host ajeno → rechazada (se mira el HOST, no el string)',
        isCdnAttachmentUrl(`https://evil.com/x?u=https://${CDN}/uploads/x.jpg`, CDN) === false],
    ['javascript: → rechazada', isCdnAttachmentUrl(`javascript:alert(1)`, CDN) === false],
    ['no-string (número/objeto/null) → rechazada',
        isCdnAttachmentUrl(123 as any, CDN) === false &&
        isCdnAttachmentUrl({} as any, CDN) === false &&
        isCdnAttachmentUrl(null, CDN) === false],
    ['sin CDN configurado (host null) → rechaza todo (fail-closed)',
        isCdnAttachmentUrl(ok, null) === false],

    // — filterCdnAttachmentUrls —
    ['filtra un array mixto dejando solo las del CDN',
        JSON.stringify(filterCdnAttachmentUrls([ok, evil, okSigned], CDN)) ===
            JSON.stringify([ok, okSigned])],
    ['array sin válidas → []',
        filterCdnAttachmentUrls([evil, 'no-url', 42], CDN).length === 0],
    ['no-array (null/undefined) → []',
        filterCdnAttachmentUrls(null, CDN).length === 0 &&
        filterCdnAttachmentUrls(undefined, CDN).length === 0],
    ['string suelto válido → [url]',
        JSON.stringify(filterCdnAttachmentUrls(ok, CDN)) === JSON.stringify([ok])],

    // — partitionAttachmentUrls: el descarte tiene que ser contable —
    ['guarda las válidas y cuenta las malas, por tipo',
        JSON.stringify(partitionAttachmentUrls({ imageUrl: [ok, evil, okSigned] }, CDN)) ===
            JSON.stringify({
                kept: { imageUrl: [ok, okSigned], videoUrl: [], pdfUrl: [] },
                dropped: { imageUrl: 1, videoUrl: 0, pdfUrl: 0 },
                cdnUnconfigured: false,
                requested: 3,
            })],
    ['los tres campos a la vez',
        (() => {
            const p = partitionAttachmentUrls(
                { imageUrl: evil, videoUrl: `https://${CDN}/v.mp4`, pdfUrl: [evil, evil] },
                CDN
            );
            return (
                p.kept.imageUrl.length === 0 &&
                p.kept.videoUrl.length === 1 &&
                p.dropped.imageUrl === 1 &&
                p.dropped.pdfUrl === 2 &&
                p.requested === 4 &&
                Object.values(p.kept).every(Array.isArray)
            );
        })()],
    ['string suelto cuenta como uno',
        partitionAttachmentUrls({ imageUrl: evil }, CDN).dropped.imageUrl === 1],
    ['sin adjuntos: nada guardado, nada caído, requested 0',
        (() => {
            const p = partitionAttachmentUrls({ text: 'hola' }, CDN);
            return p.requested === 0 &&
                Object.values(p.dropped).every((n) => n === 0) &&
                Object.values(p.kept).every((a) => a.length === 0);
        })()],
    ['CDN sin configurar: se descarta todo PERO se puede decir por qué',
        (() => {
            const p = partitionAttachmentUrls({ imageUrl: [ok] }, null);
            return p.cdnUnconfigured === true &&
                p.dropped.imageUrl === 1 &&
                p.kept.imageUrl.length === 0;
        })()],
    ['CDN configurado: cdnUnconfigured false (no se confunde con un link malo)',
        partitionAttachmentUrls({ imageUrl: [evil] }, CDN).cdnUnconfigured === false],
    ['payload inexistente no revienta (data puede venir raro)',
        partitionAttachmentUrls(undefined, CDN).requested === 0 &&
        partitionAttachmentUrls(null, CDN).requested === 0],
];

export const runAttachmentUrlTests = (): { pass: number; fail: number } => {
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
