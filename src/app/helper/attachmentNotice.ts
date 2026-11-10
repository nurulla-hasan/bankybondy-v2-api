import type { AttachmentPartition } from './attachmentUrl';
import { errorLogger } from '../shared/logger';

// Socket and io.to(room) share emit(), so one function covers socket and HTTP paths.
type Emisor = { emit: (event: string, payload: unknown) => void };

export const totalDropped = (dropped: AttachmentPartition['dropped']): number =>
    dropped.imageUrl + dropped.videoUrl + dropped.pdfUrl;

// Reports attachments that were NOT stored (previously dropped silently). New additive
// event: sent to the sender, the only party able to re-upload.
export const notifyDroppedAttachments = (
    target: Emisor,
    attachments: AttachmentPartition,
    refs: { conversationId?: unknown; messageId?: unknown; clientId?: unknown }
): void => {
    const dropped = totalDropped(attachments.dropped);
    if (dropped <= 0) return;

    // Fail-closed: no CLOUDFRONT_URL means everything dropped; log it so the loss is visible.
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
