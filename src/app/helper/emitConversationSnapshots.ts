import { Server as IOServer } from 'socket.io';
import { ENUM_CONVERSATION_TYPE } from '../modules/conversation/conversation.enum';
import { getSingleConversation } from './getSingleConversation';

type PopulateField = 'participants' | 'chatGroup' | 'bondLink';

// Populated field depends on conversation type; must match what `send-message` branches emit.
export const fieldForType = (type?: string): PopulateField => {
    if (type === ENUM_CONVERSATION_TYPE.chatGroup) return 'chatGroup';
    if (type === ENUM_CONVERSATION_TYPE.bondLinkGroup) return 'bondLink';
    return 'participants';
};

/**
 * Refreshes the chat-list row live for each target user.
 * No `userIds` means all participants; the row is per-user, so one emit per person.
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
