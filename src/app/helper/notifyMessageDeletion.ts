import { Server as IOServer } from 'socket.io';
import Conversation from '../modules/conversation/conversation.model';
import { emitConversationSnapshots } from './emitConversationSnapshots';

/**
 * Avisar del borrado a los que están en la conversación.
 *
 * La respuesta de `DELETE /message/delete-message/:id` es el documento borrado,
 * que solo ve quien lo borro. El otro lado se quedaba con el texto en la burbuja
 * y con el preview intacto en su lista hasta el próximo refresco — y si era el
 * último mensaje, el preview mostraba contenido que ya no existe.
 *
 * Acá (y no dentro de `message.service`) porque el servicio no debe conocer la
 * capa de sockets: `socket.ts` importa `handleChat`, que importa `message.service`,
 * así que un `import` del `io` en el servicio cerraría un ciclo de módulos.
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

        // Y la fila de la lista: el preview va a salir vacío con isDeleted=true
        // (scrubDeletedPreview), no con el texto borrado.
        await emitConversationSnapshots(io, {
            _id: conversation._id,
            type: conversation.type,
            participants: conversation.participants,
        });
    } catch {
        // Silencioso a proposito: se pierde el aviso, no el borrado (ya quedó escrito).
    }
};
