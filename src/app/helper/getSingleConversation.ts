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

    query = query.populate({ path: 'lastMessage', model: 'Message' });

    const populateOptions: Record<PopulateField, any> = {
        participants: {
            path: 'participants',
            // No `email`: same leak as the chat list, via the socket path.
            // See the note on userData projection in conversation.service.ts.
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

    // unseen count uses `seenBy` only: unread = not sent by me and my id absent from seenBy.
    const countUnseenMessage = await Message.countDocuments({
        conversationId: conversation._id,
        // Deleted messages don't count: the navbar counter filters them too, and
        // without this the badge pointed at a message that no longer exists.
        isDeleted: { $ne: true },
        msgByUserId: { $ne: currentUserId },
        seenBy: { $ne: currentUserId },
    });

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
        // Socket gate for `conversation`: scrub first or the preview leaks deleted text.
        lastMessage: scrubPreview(toPlainPreview(conversation.lastMessage)),
        type: conversation.type,
        chatGroup: conversation.chatGroup,
        bondLink: conversation.bondLink,
    };
};
