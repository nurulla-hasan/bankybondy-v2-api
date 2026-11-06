/*
 * Vista previa del último mensaje (`lastMessage`), sin el contenido de un
 * mensaje borrado.
 *
 * POR QUÉ: `getMessages` ya anula text/imageUrl/videoUrl/pdfUrl cuando
 * `isDeleted` (ver message.pipeline.ts, marca M2), pero el listado de chats y el
 * evento `conversation` del socket entregaban el documento `lastMessage` CRUDO.
 * Resultado: borrar el mensaje más reciente borraba el mensaje pero dejaba su
 * texto entero en la lista de chats de la otra persona — y en su panel de
 * notificaciones — hasta que se abría el chat. Es el mismo dato, por otra puerta.
 *
 * Las claves se declaran UNA vez (`PREVIEW_KEYS` / `CONTENT_KEYS`) y de ahí salen
 * las dos implementaciones (etapa de agregación y función JS), porque si se
 * separan, una de las dos puertas empieza a filtrar y la otra no.
 *
 * `seenBy` y `__v` a propósito NO están en ninguna lista: `seenBy` nombra a todos
 * los que leyeron el mensaje (`get-messages` tampoco lo envía) y `__v` es
 * versión interna de mongoose. `isDeleted` y `_id` sí viajan, para que el
 * cliente pueda dibujar "Mensaje borrado" en vez de un hueco.
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

/** ¿Esto es una vista previa de un mensaje borrado? */
const isDeletedPreview = (lastMessage: PreviewDoc): boolean =>
    Boolean(lastMessage) && (lastMessage as Record<string, any>).isDeleted === true;

/** Etapa para el pipeline de agregación de `get-chat-list`. */
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
                // Nada que vaciar (o la conversación no tiene último mensaje):
                // se conserva EXACTAMENTE lo que había, incluido `null`.
                else: '$lastMessage',
            },
        },
    },
});

/** Versión JS para el payload del socket (`getSingleConversation`). */
export const scrubPreview = <T extends PreviewDoc>(lastMessage: T): T => {
    if (!isDeletedPreview(lastMessage)) return lastMessage;

    const source = lastMessage as Record<string, any>;
    const scrubbed: Record<string, unknown> = { isDeleted: true };
    for (const key of PREVIEW_KEYS) scrubbed[key] = source[key] ?? null;
    for (const key of CONTENT_KEYS) scrubbed[key] = null;

    return scrubbed as T;
};

/** Un documento populado puede venir como string o como documento mongoose. */
export const toPlainPreview = (lastMessage: unknown): PreviewDoc => {
    if (!lastMessage) return null;
    const doc = lastMessage as { toObject?: () => Record<string, any> };
    return typeof doc.toObject === 'function' ? doc.toObject() : (doc as Record<string, any>);
};
