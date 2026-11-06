import { Server as IOServer } from 'socket.io';
import Conversation from '../modules/conversation/conversation.model';
import { emitConversationSnapshots } from './emitConversationSnapshots';

/**
 * Aparecer (o refrescar) el chat de un grupo en la lista de los que pasan a
 * formar parte de él.
 *
 * Sin esto, entrar a un grupo por HTTP no se veía en vivo: el nuevo miembro
 * tenía que cerrar y abrir la app para que la fila apareciera, porque la lista
 * solo se actualiza por el evento `conversation` del socket — y ese evento lo
 * emitía únicamente `send-message`.
 *
 * `userIds` limitado a los que ENTRAN. Al que se le saca del grupo no se le
 * emite nada: su fila desaparece sola al refrescar, y avisarle en vivo sería
 * mandarle información que no necesita.
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
        // Best-effort: el alta ya quedó escrita; lo único que se pierde es el aviso.
    }
};
