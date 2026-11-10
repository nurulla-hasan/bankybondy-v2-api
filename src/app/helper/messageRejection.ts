/* eslint-disable @typescript-eslint/no-explicit-any */
// Type-only imports on purpose: `import type` erases at compile time, so these
// rejections are testable without loading models or the logger. Both transports
// (socket and REST) build their error payload here.
import type { SafetyResult } from './isTextSafe';
import type { AttachmentPartition } from './attachmentUrl';

// Same payload for both transports: the socket forwards it to `emitError`, REST
// uses `code` as HTTP status and `message` as the `AppError` text.
export type ErrorPayload = {
    code: number;
    message: string;
    type: 'general';
    details: unknown;
};

// Content rejection. `details` is an OBJECT so the client can remove the exact
// optimistic bubble by clientId, or by text for older clients that omit it.
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

// Rejection for a message with only attachments and none passing the CDN filter:
// storing it left an empty, unrecoverable bubble since the file was lost. If text
// is present it still goes through (nothing returned).
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
        // `clientId` so the client can mark THAT bubble as failed.
        details: {
            kind: 'empty_message',
            clientId,
            dropped: attachments.dropped,
            reason: attachments.cdnUnconfigured ? 'cdn_unconfigured' : 'not_cdn_url',
        },
    };
};
