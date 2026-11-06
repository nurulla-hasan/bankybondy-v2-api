/* Prueba pura de los dos rechazos del envío (sin DB ni red).
 *
 * Son los payloads que ven el socket y REST con el MISMO código
 * (helper/messageRejection.ts). Si se deforma `kind` o se pierde `clientId`, el
 * cliente no puede borrar la burbuja optimista correcta y el mensaje rechazado
 * queda visible para quien lo escribió. */
import { emptyMessageFailure, moderationFailure } from './messageRejection';
import type { AttachmentPartition } from './attachmentUrl';

type Case = [name: string, cond: boolean];

const part = (over: Partial<AttachmentPartition> = {}): AttachmentPartition => ({
    kept: { imageUrl: [], videoUrl: [], pdfUrl: [] },
    dropped: { imageUrl: 0, videoUrl: 0, pdfUrl: 0 },
    cdnUnconfigured: false,
    requested: 0,
    ...over,
});

const moderado = (safe: boolean, reason?: string) =>
    moderationFailure('hola', { safe, reason }, 'c1');
const details = (p: ReturnType<typeof moderationFailure>) =>
    JSON.stringify(p?.details);

const casos: Case[] = [
    // — moderación —
    ['texto aprobado no es rechazo', moderado(true) === null],
    [
        'texto rechazado es 422',
        moderado(false, 'No se permiten pagos.')?.code === 422,
    ],
    [
        'la razon del veredicto es el mensaje que ve el usuario',
        moderado(false, 'No se permiten pagos.')?.message ===
            'No se permiten pagos.',
    ],
    [
        'veredicto rechazado sin razon -> texto propio, nunca undefined',
        moderado(false)?.message ===
            'Este mensaje no cumple las normas de la plataforma.',
    ],
    [
        'details lleva kind, text y clientId (el objeto que espera el front)',
        details(moderado(false, 'x')) ===
            JSON.stringify({
                kind: 'message_blocked',
                text: 'hola',
                clientId: 'c1',
            }),
    ],
    [
        'los espacios del texto rechazado viaja intacto (no se recorta)',
        details(
            moderationFailure('  hola  ', { safe: false, reason: 'x' }, 'c1')
        )?.includes('"text":"  hola  "') === true,
    ],
    [
        'clientId ausente viaja como clave presente y undefined, no se inventa',
        (() => {
            const d = moderationFailure('hola', { safe: false, reason: 'x' }, undefined)
                ?.details as Record<string, unknown>;
            return 'clientId' in d && d.clientId === undefined;
        })(),
    ],

    // — mensaje que se quedó sin contenido —
    [
        'adjunto descartado sin texto ni adjunto guardable -> 400',
        emptyMessageFailure(
            '',
            part({
                dropped: { imageUrl: 1, videoUrl: 0, pdfUrl: 0 },
                requested: 1,
            }),
            'c1'
        )?.code === 400,
    ],
    [
        'texto + adjunto descartado: el texto viaja, no se rechaza',
        emptyMessageFailure(
            'mira el pdf',
            part({ dropped: { imageUrl: 0, videoUrl: 0, pdfUrl: 1 }, requested: 1 }),
            'c1'
        ) === null,
    ],
    [
        'adjunto valido guardado: no hay nada que rechazar',
        emptyMessageFailure(
            '',
            part({
                kept: { imageUrl: ['https://cdn/x.jpg'], videoUrl: [], pdfUrl: [] },
                dropped: { imageUrl: 1, videoUrl: 0, pdfUrl: 0 },
                requested: 2,
            }),
            'c1'
        ) === null,
    ],
    [
        'sin texto y sin adjuntos NO es rechazo: se guarda como siempre',
        emptyMessageFailure('', part(), 'c1') === null,
    ],
    [
        'espacios en blanco no salvan un mensaje cuyo unico contenido se descarto',
        emptyMessageFailure(
            '   ',
            part({ dropped: { imageUrl: 0, videoUrl: 1, pdfUrl: 0 }, requested: 1 }),
            'c1'
        ) !== null,
    ],
    [
        'reason dice cdn_unconfigured cuando el CDN no esta configurado',
        (emptyMessageFailure(
            '',
            part({
                dropped: { imageUrl: 1, videoUrl: 0, pdfUrl: 0 },
                cdnUnconfigured: true,
                requested: 1,
            }),
            'c1'
        )?.details as any)?.reason === 'cdn_unconfigured',
    ],
    [
        'reason dice not_cdn_url cuando el CDN si esta y el link era ajeno',
        (emptyMessageFailure(
            '',
            part({ dropped: { imageUrl: 1, videoUrl: 0, pdfUrl: 0 }, requested: 1 }),
            'c1'
        )?.details as any)?.reason === 'not_cdn_url',
    ],
    [
        'el desglose por tipo viaja tal cual, no una suma',
        JSON.stringify(
            (emptyMessageFailure(
                '',
                part({
                    dropped: { imageUrl: 2, videoUrl: 0, pdfUrl: 1 },
                    requested: 3,
                }),
                'c9'
            )?.details as any)?.dropped
        ) === JSON.stringify({ imageUrl: 2, videoUrl: 0, pdfUrl: 1 }),
    ],
    [
        'kind empty_message y clientId para marcar ESA burbuja como fallada',
        (emptyMessageFailure(
            '',
            part({ dropped: { imageUrl: 1, videoUrl: 0, pdfUrl: 0 }, requested: 1 }),
            'c9'
        )?.details as any)?.kind === 'empty_message' &&
            (emptyMessageFailure(
                '',
                part({ dropped: { imageUrl: 1, videoUrl: 0, pdfUrl: 0 }, requested: 1 }),
                'c9'
            )?.details as any)?.clientId === 'c9',
    ],

    // — lo que los dos transportes comparten —
    [
        'los dos rechazos son type general (los exige emitError)',
        moderado(false, 'x')?.type === 'general' &&
            emptyMessageFailure(
                '',
                part({ dropped: { imageUrl: 1, videoUrl: 0, pdfUrl: 0 }, requested: 1 }),
                'c1'
            )?.type === 'general',
    ],
    [
        'el codigo numerico va tal cual: REST lo usa como estado HTTP',
        moderado(false, 'x')?.code === 422 &&
            emptyMessageFailure(
                '',
                part({ dropped: { imageUrl: 1, videoUrl: 0, pdfUrl: 0 }, requested: 1 }),
                'c1'
            )?.code === 400,
    ],
    [
        'ningun rechazo devuelve details como string',
        [moderado(false, 'x'), emptyMessageFailure('', part({ dropped: { imageUrl: 1, videoUrl: 0, pdfUrl: 0 }, requested: 1 }), 'c1')].every(
            (p) => typeof p?.details === 'object'
        ),
    ],
];

export const runMessageRejectionTests = (): { pass: number; fail: number } => {
    let pass = 0,
        fail = 0;
    for (const [name, cond] of casos) {
        if (cond) pass++;
        else {
            fail++;
            // eslint-disable-next-line no-console
            console.error('FAIL:', name);
        }
    }
    return { pass, fail };
};
