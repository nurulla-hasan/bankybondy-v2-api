/* eslint-disable @typescript-eslint/no-explicit-any */
/* Pruebas puras del validador de URLs de adjuntos (sin DB ni red).
 * Blindan el socket `send-message`: si vuelve a aceptarse una URL que no es de
 * nuestro CDN como adjunto, estas aserciones fallan y el gate corta. */
import { isCdnAttachmentUrl, filterCdnAttachmentUrls } from './attachmentUrl';

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
