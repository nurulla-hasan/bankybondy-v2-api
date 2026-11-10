import { Server as IOServer } from 'socket.io';
import MessageService from '../modules/message/message.service';

// Emits the receiver's unread count (B.5). Best-effort: must never break the
// message-send flow.
export const emitUnreadCount = async (io: IOServer, receiverId: string) => {
    try {
        const { totalUnread, perConversation } =
            await MessageService.getUnreadMessageCount(receiverId);
        io.to(receiverId.toString()).emit('message-notification', {
            totalUnread,
            perConversation,
        });
    } catch {
        // Intentionally silent: the notification is secondary to the message.
    }
};
