import { Server as IOServer } from 'socket.io';
import MessageService from '../modules/message/message.service';

// Emite al receptor su conteo de mensajes no leidos (B.5). Best-effort: no debe
// romper el flujo de envio de mensajes si algo falla.
export const emitUnreadCount = async (io: IOServer, receiverId: string) => {
    try {
        const { totalUnread, perConversation } =
            await MessageService.getUnreadMessageCount(receiverId);
        io.to(receiverId.toString()).emit('message-notification', {
            totalUnread,
            perConversation,
        });
    } catch {
        // Silencioso a proposito: la notificacion es secundaria al mensaje.
    }
};
