import type { AttachmentPartition } from './attachmentUrl';
import { errorLogger } from '../shared/logger';

// Un `Socket` y un `io.to(profileId)` comparten `.emit(evento, payload)`: con ese
// mínimo la misma función avisa tanto en el envío por socket como en el por HTTP,
// que no tiene un socket propio pero sí la sala del usuario.
type Emisor = { emit: (event: string, payload: unknown) => void };

export const totalDropped = (dropped: AttachmentPartition['dropped']): number =>
    dropped.imageUrl + dropped.videoUrl + dropped.pdfUrl;

// AVISO de adjuntos que NO se guardaron. `filterCdnAttachmentUrls` los tiraba en
// silencio: el cliente veía su burbuja "enviada" con el archivo perdido para
// siempre. Es un evento NUEVO y aditivo (un cliente viejo lo ignora) y va al
// emisor, que es el único que puede re-subir el archivo.
export const notifyDroppedAttachments = (
    target: Emisor,
    attachments: AttachmentPartition,
    refs: { conversationId?: unknown; messageId?: unknown; clientId?: unknown }
): void => {
    const dropped = totalDropped(attachments.dropped);
    if (dropped <= 0) return;

    // Sin CLOUDFRONT_URL se descarta TODO por fail-closed. No se guarda el link
    // ajeno (eso no se negocia), pero al menos queda en el log y el cliente puede
    // decir "subidas no disponibles" en vez de perder el archivo sin más.
    const reason = attachments.cdnUnconfigured ? 'cdn_unconfigured' : 'not_cdn_url';
    if (attachments.cdnUnconfigured) {
        errorLogger.error(
            `adjuntos: CLOUDFRONT_URL no esta configurado, se descartaron ${dropped} adjunto(s) (mensaje: ${String(
                refs.messageId ?? 'sin guardar'
            )})`
        );
    }

    target.emit('attachment-rejected', {
        ...refs,
        dropped: attachments.dropped,
        reason,
    });
};
