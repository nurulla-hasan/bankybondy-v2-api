/* eslint-disable @typescript-eslint/no-explicit-any */
import Conversation from '../modules/conversation/conversation.model';
import Message from '../modules/message/message.model';
import { scrubPreview, toPlainPreview } from './scrubDeletedPreview';

type PopulateField = 'participants' | 'chatGroup' | 'bondLink';

export const getSingleConversation = async (
    conversationId: string,
    currentUserId: string,
    populateField?: PopulateField // only one field will be passed
) => {
    let query = Conversation.findById(conversationId).sort({ updatedAt: -1 });

    // always populate lastMessage
    query = query.populate({ path: 'lastMessage', model: 'Message' });

    // optional populate based on param
    const populateOptions: Record<PopulateField, any> = {
        participants: {
            path: 'participants',
            // Sin `email`: misma fuga que la lista de chats, por la via del socket.
            // Ver la nota en conversation.service.ts (proyeccion de userData).
            select: 'name profile_image _id',
        },
        chatGroup: { path: 'chatGroup', select: 'name image' },
        bondLink: { path: 'bondLink', select: 'name' },
    };

    if (populateField) {
        query = query.populate(populateOptions[populateField]);
    }

    const conversation = await query.exec();
    if (!conversation) return null;

    // count unseen messages (unificado sobre `seenBy`): un mensaje esta no
    // leido si no lo envio el usuario y su id no esta en el array `seenBy`.
    const countUnseenMessage = await Message.countDocuments({
        conversationId: conversation._id,
        // Un mensaje BORRADO no cuenta como no leído. El contador global del
        // navbar (getUnreadMessageCount) sí lo filtra, y sin esta línea los dos
        // números se contradecían: si alguien borraba un mensaje antes de que lo
        // leyeras, el navbar decía 0 pero la conversación quedaba en negrita con
        // badge, apuntando a un mensaje que ya no existe.
        isDeleted: { $ne: true },
        msgByUserId: { $ne: currentUserId },
        seenBy: { $ne: currentUserId },
    });

    // extract the "other" participant if participants were populated
    const otherUser: any = conversation.participants?.find(
        (participant: any) => participant._id.toString() !== currentUserId
    );

    return {
        _id: conversation._id,
        userData:
            populateField === 'participants' && otherUser
                ? {
                      _id: otherUser._id,
                      name: otherUser.name,
                      profileImage: otherUser.profile_image,
                  }
                : null,
        unseenMsg: countUnseenMessage,
        // always populated; puerta del socket para `conversation`: sin vaciar el
        // borrado, el preview mostraría el texto de un mensaje ya eliminado.
        lastMessage: scrubPreview(toPlainPreview(conversation.lastMessage)),
        type: conversation.type,
        chatGroup: conversation.chatGroup,
        bondLink: conversation.bondLink,
    };
};
