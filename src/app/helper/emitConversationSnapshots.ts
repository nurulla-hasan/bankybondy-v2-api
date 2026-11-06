import { Server as IOServer } from 'socket.io';
import { ENUM_CONVERSATION_TYPE } from '../modules/conversation/conversation.enum';
import { getSingleConversation } from './getSingleConversation';

type PopulateField = 'participants' | 'chatGroup' | 'bondLink';

// El campo que hay que poblar depende del TIPO de conversación: es el que el
// cliente usa para dibujar la fila (el par, el grupo, el vínculo). Idéntico a lo
// que ya mandan las ramas de `send-message`.
export const fieldForType = (type?: string): PopulateField => {
    if (type === ENUM_CONVERSATION_TYPE.chatGroup) return 'chatGroup';
    if (type === ENUM_CONVERSATION_TYPE.bondLinkGroup) return 'bondLink';
    return 'participants';
};

/**
 * Refresca la fila de la lista de chats, en vivo, para cada usuario indicado.
 *
 * Sin `userIds` va a TODOS los participantes; con `userIds`, solo a esos. La
 * fila es por usuario (`unseenMsg` y el par cambian según quién la mire), así que
 * se emite una por persona, igual que hacen las ramas de `send-message`.
 */
export const emitConversationSnapshots = async (
    io: IOServer,
    conversation: {
        _id: unknown;
        type?: string;
        participants?: unknown[];
    },
    userIds?: string[]
): Promise<void> => {
    const targets =
        userIds ?? (conversation.participants ?? []).map((p) => String(p));

    for (const uid of targets) {
        const snapshot = await getSingleConversation(
            conversation._id.toString(),
            uid,
            fieldForType(conversation.type)
        );
        if (snapshot) io.to(uid).emit('conversation', snapshot);
    }
};
