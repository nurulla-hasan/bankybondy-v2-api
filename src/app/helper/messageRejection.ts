/* eslint-disable @typescript-eslint/no-explicit-any */
// Sin importaciones de runtime a propósito: `import type` se borra al compilar,
// así que estos dos rechazos se pueden probar sin arrastrar los modelos ni el
// logger. Las dos ramas del envío (socket y REST) arman acá su payload de error.
import type { SafetyResult } from './isTextSafe';
import type { AttachmentPartition } from './attachmentUrl';

// Mismo payload para los dos transportes: el socket lo pasa a `emitError` y REST
// toma `code` como estado HTTP y `message` como texto del `AppError`.
export type ErrorPayload = {
    code: number;
    message: string;
    type: 'general';
    details: unknown;
};

// Rechazo por contenido. El `details` es OBJETO (no string) para que el cliente
// ubique y borre la burbuja optimista EXACTA por su clientId, o por texto si es un
// cliente viejo que no mandó `clientId`.
export const moderationFailure = (
    msgText: string,
    verdict: SafetyResult,
    clientId: unknown
): ErrorPayload | null =>
    verdict.safe
        ? null
        : {
              code: 422,
              message:
                  verdict.reason ||
                  'Este mensaje no cumple las normas de la plataforma.',
              type: 'general',
              details: {
                  kind: 'message_blocked',
                  text: msgText,
                  clientId,
              },
          };

// Rechazo de un mensaje que SOLO tenía adjuntos y ninguno pasó el filtro del CDN:
// guardarlo era una burbuja vacía e irrecuperable, porque el archivo ya se perdió.
// Si además trajo texto, el texto sí viaja (no se devuelve nada).
export const emptyMessageFailure = (
    msgText: string,
    attachments: AttachmentPartition,
    clientId: unknown
): ErrorPayload | null => {
    if (msgText.trim()) return null;
    if (Object.values(attachments.kept).some((urls) => urls.length > 0)) {
        return null;
    }
    const dropped =
        attachments.dropped.imageUrl +
        attachments.dropped.videoUrl +
        attachments.dropped.pdfUrl;
    if (dropped <= 0) return null;
    return {
        code: 400,
        message: 'Attachment not accepted',
        type: 'general',
        // `clientId` para que el cliente marque ESA burbuja como fallada.
        details: {
            kind: 'empty_message',
            clientId,
            dropped: attachments.dropped,
            reason: attachments.cdnUnconfigured ? 'cdn_unconfigured' : 'not_cdn_url',
        },
    };
};
