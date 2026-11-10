import { Server as IOServer } from 'socket.io';
import Conversation from '../modules/conversation/conversation.model';
import { emitConversationSnapshots } from './emitConversationSnapshots';

/**
 * Push a group's conversation row to newly added members so it shows up live
 * without an app refresh. Only joining members are notified; removed members
 * get nothing (their row disappears on refresh).
 */
export const notifyGroupConversation = async (
    io: IOServer | null,
    chatGroupId: unknown,
    userIds?: string[]
): Promise<void> => {
    if (!io || !chatGroupId) return;
    try {
        const conversation = await Conversation.findOne({
            chatGroup: chatGroupId,
        }).select('participants type');
        if (!conversation) return;

        await emitConversationSnapshots(
            io,
            {
                _id: conversation._id,
                type: conversation.type,
                participants: conversation.participants,
            },
            userIds
        );
    } catch {
        // Best-effort: the membership write already happened; only the live push is lost.
    }
};
