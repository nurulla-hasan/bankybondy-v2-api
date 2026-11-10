import { Server as IOServer } from 'socket.io';
import Conversation from '../modules/conversation/conversation.model';
import { emitConversationSnapshots } from './emitConversationSnapshots';

/**
 * Tells the conversation's members about a deletion (the HTTP response only reaches the deleter).
 * Lives here, not in `message.service`, to avoid an `io` import cycle.
 */
export const notifyMessageDeletion = async (
    io: IOServer | null,
    message: { _id: unknown; conversationId: unknown } | null | undefined,
    deletedBy: string
): Promise<void> => {
    if (!io || !message?.conversationId) return;
    try {
        const conversation = await Conversation.findById(
            message.conversationId
        ).select('participants type');
        if (!conversation) return;

        io.to((conversation.participants ?? []).map((p: any) => p.toString())).emit(
            'message-deleted',
            {
                conversationId: conversation._id,
                messageId: message._id,
                deletedBy,
            }
        );

        // Also the list row: the preview comes out empty with isDeleted=true (scrubDeletedPreview).
        await emitConversationSnapshots(io, {
            _id: conversation._id,
            type: conversation.type,
            participants: conversation.participants,
        });
    } catch {
        // Silent on purpose: the notice is lost, not the deletion (already persisted).
    }
};
