/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * Mark other users' messages as seen in ONE conversation; shared by the socket
 * `seen` event and `POST /message/mark-seen`. Live emits need `io`.
 */
import { Server as IOServer } from 'socket.io';
import Conversation from '../modules/conversation/conversation.model';
import Message from '../modules/message/message.model';
import { esObjectIdUsable } from '../utilities/objectId';
import { emitUnreadCount } from './emitUnreadCount';
import { getSingleConversation } from './getSingleConversation';

export type MarkSeenResult = 'invalid' | 'not_found' | 'seen';

export type MarkSeenInput = {
    conversationId: unknown;
    currentUserId: string;
    io?: IOServer | null;
};

type MarkSeenDeps = {
    findConversation: (id: unknown) => PromiseLike<any>;
    markMessagesSeen: (conversationId: unknown, currentUserId: string) => PromiseLike<any>;
};

// Split out to test its SHAPE without a DB: `$addToSet` avoids duplicate ids
// and `msgByUserId: {$ne: me}` skips my own messages.
export const seenQueryFor = (
    conversationId: unknown,
    currentUserId: string
): { filter: Record<string, unknown>; update: Record<string, unknown> } => ({
    filter: { conversationId, msgByUserId: { $ne: currentUserId } },
    update: { $addToSet: { seenBy: currentUserId } },
});

const realDeps: MarkSeenDeps = {
    findConversation: (id) => Conversation.findById(id).select('participants'),
    markMessagesSeen: (conversationId, currentUserId) => {
        const { filter, update } = seenQueryFor(conversationId, currentUserId);
        return Message.updateMany(filter, update);
    },
};

export const markSeen = async (
    { conversationId, currentUserId, io }: MarkSeenInput,
    deps: MarkSeenDeps = realDeps
): Promise<MarkSeenResult> => {
    // NoSQL injection: socket payloads skip `sanitizeMongo` (Express-only), and
    // mongoose keeps operators in findById/updateMany, so an object id could mark
    // messages across every conversation of the platform.
    if (!esObjectIdUsable(conversationId)) return 'invalid';

    // IDOR guard: only a participant may mark the conversation as seen.
    const conversation = await deps.findConversation(conversationId);
    if (!conversation) return 'not_found';

    const participants: string[] = (conversation.participants ?? []).map(
        (p: any) => p?.toString()
    );
    if (!participants.includes(currentUserId.toString())) return 'not_found';

    // Defense in depth: use the verified document's real `_id`, never the
    // client value, so updateMany always touches a single conversation.
    await deps.markMessagesSeen(conversation._id, currentUserId);

    if (!io) return 'seen';

    // Refresh the reader's unread count server-side (multi-device).
    await emitUnreadCount(io, currentUserId.toString());

    // Derive the other participant from the conversation already loaded.
    const otherId = participants.find((id) => id !== currentUserId.toString());

    const conversationSender = await getSingleConversation(
        conversation._id.toString(),
        currentUserId.toString(),
        'participants'
    );
    if (conversationSender) {
        io.to(currentUserId.toString()).emit('conversation', conversationSender);
    }

    if (otherId) {
        const conversationReceiver = await getSingleConversation(
            conversation._id.toString(),
            otherId,
            'participants'
        );
        if (conversationReceiver) {
            io.to(otherId).emit('conversation', conversationReceiver);
        }
    }

    return 'seen';
};
