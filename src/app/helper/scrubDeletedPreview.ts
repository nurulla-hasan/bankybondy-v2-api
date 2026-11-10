/*
 * Preview of `lastMessage` with deleted content stripped: the raw doc leaked
 * deleted text into the other user's chat list and notifications. Keys come from
 * PREVIEW_KEYS/CONTENT_KEYS so the aggregation stage and the JS path can't
 * diverge. `seenBy`/`__v` stay out; `isDeleted`/`_id` travel so the client can
 * render "Mensaje borrado".
 */
const PREVIEW_KEYS = [
    '_id',
    'msgByUserId',
    'conversationId',
    'createdAt',
    'updatedAt',
] as const;

const CONTENT_KEYS = ['text', 'imageUrl', 'videoUrl', 'pdfUrl'] as const;

type PreviewDoc = Record<string, any> | null | undefined;

/** Is this a preview of a deleted message? */
const isDeletedPreview = (lastMessage: PreviewDoc): boolean =>
    Boolean(lastMessage) && (lastMessage as Record<string, any>).isDeleted === true;

/** Aggregation stage for `get-chat-list`. */
export const scrubLastMessageStage = (): Record<string, any> => ({
    $addFields: {
        lastMessage: {
            $cond: {
                if: { $eq: ['$lastMessage.isDeleted', true] },
                then: {
                    ...Object.fromEntries(
                        PREVIEW_KEYS.map((key) => [key, `$lastMessage.${key}`])
                    ),
                    ...Object.fromEntries(CONTENT_KEYS.map((key) => [key, null])),
                    isDeleted: true,
                },
                // Nothing to scrub (or no last message): keep exactly what was
                // there, including `null`.
                else: '$lastMessage',
            },
        },
    },
});

/** JS version for the socket payload (`getSingleConversation`). */
export const scrubPreview = <T extends PreviewDoc>(lastMessage: T): T => {
    if (!isDeletedPreview(lastMessage)) return lastMessage;

    const source = lastMessage as Record<string, any>;
    const scrubbed: Record<string, unknown> = { isDeleted: true };
    for (const key of PREVIEW_KEYS) scrubbed[key] = source[key] ?? null;
    for (const key of CONTENT_KEYS) scrubbed[key] = null;

    return scrubbed as T;
};

/** A populated doc may arrive as a string or a mongoose document. */
export const toPlainPreview = (lastMessage: unknown): PreviewDoc => {
    if (!lastMessage) return null;
    const doc = lastMessage as { toObject?: () => Record<string, any> };
    return typeof doc.toObject === 'function' ? doc.toObject() : (doc as Record<string, any>);
};
