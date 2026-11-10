/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from 'mongoose';
import { Server as IOServer, Socket } from 'socket.io';
import { getSingleConversation } from '../helper/getSingleConversation';
import { BondLink } from '../modules/bondLink/bondLink.model';
import ChatGroup from '../modules/chatGroup/chatGroup.model';
import Conversation from '../modules/conversation/conversation.model';
import Message from '../modules/message/message.model';
import { getBlockedIdsFor } from '../modules/userBlock/userBlock.service';
import { isMessageSafe, type SafetyResult } from '../helper/isTextSafe';
import { partitionAttachmentUrls } from '../helper/attachmentUrl';
import { notifyDroppedAttachments } from '../helper/attachmentNotice';
import { normalizeMessageText } from '../helper/normalizeMessageText';
import { emitUnreadCount } from '../helper/emitUnreadCount';
import { markSeen } from '../helper/markSeen';
import { createOneToOneMessage } from '../helper/createOneToOneMessage';
import { shapeSentMessage } from '../helper/messageEmitShape';
import {
    emptyMessageFailure,
    moderationFailure,
} from '../helper/messageRejection';
import { emitError } from './helper';

// Is the user a participant of this chat? (anti-IDOR guard)
const isParticipant = (participants: any[], userId: string): boolean =>
    Array.isArray(participants) &&
    participants.some((p) => p?.toString() === userId?.toString());

// Does the sender have a block relation (either way) with anyone in this group chat?
// Group branches validated membership only, so a block made AFTER the group was formed
// had no effect. Complements the creation guard in bondLink.service. Compares the sender
// against the rest, not all pairs: two third parties blocking each other must not silence
// an outsider.
const tieneBloqueoEnElGrupo = async (
    currentUserId: string,
    participants: any[]
): Promise<boolean> => {
    const blockedIds = await getBlockedIdsFor(currentUserId);
    if (blockedIds.length === 0) return false;
    return (
        Array.isArray(participants) &&
        participants.some((p) => blockedIds.includes(p?.toString()))
    );
};

// Single error payload for the group block cut. Never says WHO is blocked: in a group
// that would expose a relation between third parties.
const emitirBloqueoDeGrupo = () => ({
    code: 403,
    message: 'You cannot message this group',
    type: 'general' as const,
    details: 'Messaging is not allowed between blocked users',
});

const handleChat = async (
    io: IOServer,
    socket: Socket,
    currentUserId: string
): Promise<void> => {
    socket.on('send-message', async (data) => {
      try {
        if (
            !data.receiver &&
            !data.groupId &&
            !data.bondLinkId
        ) {
            emitError(socket, {
                code: 400,
                message: 'Receiver, group id or bond link id required',
                type: 'general',
                details:
                    'You must provide either a receiverId (for one-to-one) or a groupId (for chat group) or a bondLinkId (for bond link chat)',
            });
            return;
        }

        // Normalize text for all three branches: a non-string used to be saved and then
        // never matched `getMessages`' fixed regex, vanishing from history with no error.
        const msgText = normalizeMessageText(data?.text);

        // Moderation (free censorship): hard list + free OpenAI layer. Blocks on send,
        // fail-open if OpenAI fails. Covers all three branches because it runs before
        // branching, and the verdict is reused by the 1-a-1 core so it is paid once.
        let moderation: SafetyResult | undefined;
        if (msgText.trim()) {
            moderation = await isMessageSafe(msgText);
            const rejected = moderationFailure(
                msgText,
                moderation,
                data?.clientId
            );
            if (rejected) {
                emitError(socket, rejected);
                return;
            }
        }

        // Attachments split once, before branching, so dropped ones can be reported and
        // empty messages are never saved.
        const attachments = partitionAttachmentUrls(data);
        const sinContenido = emptyMessageFailure(
            msgText,
            attachments,
            data?.clientId
        );
        if (sinContenido) {
            emitError(socket, sinContenido);
            return;
        }

        if (data?.receiver) {
            // Same core used by `POST /message/send`. 1-a-1 rules live in
            // helper/createOneToOneMessage.ts, not here, so no transport can skip them.
            const result = await createOneToOneMessage({
                currentUserId,
                receiver: data.receiver,
                text: msgText,
                imageUrl: data?.imageUrl,
                videoUrl: data?.videoUrl,
                pdfUrl: data?.pdfUrl,
                clientId: data?.clientId,
                moderation,
                io,
            });
            if (result.error) {
                emitError(socket, result.error);
            }
        } else if (data?.groupId) {
            const groupId = data?.groupId;
            if (groupId && Types.ObjectId.isValid(groupId)) {
                console.log('Valid ObjectId');
            } else {
                console.error('Invalid ObjectId');
                emitError(socket, {
                    code: 400,
                    message: 'Invalid ObjectId',
                    type: 'general',
                    details: 'You must provide valid object id',
                });
                return;
            }
            const [chatGroup, chat] = await Promise.all([
                ChatGroup.findById(data?.groupId)
                    .select('_id')
                    .lean(),
                Conversation.findOne({ chatGroup: groupId })
                    .select('_id participants')
                    .lean(),
            ]);
            if (!chat) {
                emitError(socket, {
                    code: 404,
                    message: 'Chat not found',
                    type: 'general',
                    details: 'The group chat was not found',
                });
                return;
            }
            if (!chatGroup) {
                emitError(socket, {
                    code: 400,
                    message: 'Chat group not found',
                    type: 'general',
                    details: 'Chat group not found',
                });
                return;
            }

            // Only a chat participant may send messages (anti-IDOR).
            if (!isParticipant(chat.participants, currentUserId)) {
                emitError(socket, {
                    code: 403,
                    message: 'Forbidden',
                    type: 'general',
                    details: 'You are not a participant of this chat',
                });
                return;
            }

            if (await tieneBloqueoEnElGrupo(currentUserId, chat.participants)) {
                emitError(socket, emitirBloqueoDeGrupo());
                return;
            }

            const messageData = {
                text: msgText,
                // Attachments: only our CDN URLs (client URLs could inject arbitrary links).
                imageUrl: attachments.kept.imageUrl,
                videoUrl: attachments.kept.videoUrl,
                pdfUrl: attachments.kept.pdfUrl,
                msgByUserId: currentUserId,
                conversationId: chat?._id,
            };
            const saveMessage = await Message.create(messageData);
            notifyDroppedAttachments(socket, attachments, {
                conversationId: messageData.conversationId,
                messageId: saveMessage._id,
                clientId: data?.clientId,
            });
            const populatedMessage = await saveMessage.populate({
                path: 'msgByUserId',
                select: 'name profile_image',
            });
            // B1: emit the shared shape (helper/messageEmitShape.ts), not the raw doc,
            // same keys `get-messages` returns.
            const clientMessage = shapeSentMessage(populatedMessage);
            // A16: same unhide as 1-a-1, now for GROUP chats. Hide is offered for any
            // conversation type and the listing/badge filter by hiddenBy regardless of
            // type, so a hidden group swallowed messages too. Unhide every participant
            // (the message reaches all). bondLink is untouched: there hiddenBy is used
            // on purpose by rejectBondLink to remove the user who rejected the swap.
            await Conversation.updateOne(
                { _id: chat?._id },
                {
                    $set: { lastMessage: populatedMessage._id },
                    $pull: { hiddenBy: { $in: chat.participants } },
                }
            );

            await Promise.all(
                chat.participants.map(async (participantId: Types.ObjectId) => {
                    const uid = participantId.toString();
                    io.to(uid).emit(`message-${groupId}`, clientMessage);
                    const singleConversation = await getSingleConversation(
                        chat._id.toString(),
                        uid,
                        'chatGroup'
                    );
                    io.to(uid).emit('conversation', singleConversation);

                    // Refresh the participant's unread count (single source) so badge and
                    // bold update live in groups too.
                    if (uid !== currentUserId.toString()) {
                        await emitUnreadCount(io, uid);
                    }
                })
            );
        } else if (data?.bondLinkId) {
            const bondLinkId = data?.bondLinkId;
            if (bondLinkId && Types.ObjectId.isValid(bondLinkId)) {
                console.log('Valid ObjectId');
            } else {
                console.error('Invalid ObjectId');
                emitError(socket, {
                    code: 400,
                    message: 'Invalid ObjectId',
                    type: 'general',
                    details: 'You must provide valid object id',
                });
                return;
            }
            const [bondLink, chat] = await Promise.all([
                BondLink.findById(data?.bondLinkId)
                    .select('_id')
                    .lean(),

                Conversation.findOne({ bondLink: bondLinkId })
                    .select('_id participants hiddenBy')
                    .lean(),
            ]);
            if (!chat) {
                emitError(socket, {
                    code: 404,
                    message: 'Chat not found',
                    type: 'general',
                    details: 'The bond link chat was not found',
                });
                return;
            }
            if (!bondLink) {
                emitError(socket, {
                    code: 400,
                    message: 'Bond link chat not found',
                    type: 'general',
                    details: 'Bond link chat not found',
                });
                return;
            }

            // Only a chat participant may send messages (anti-IDOR).
            if (!isParticipant(chat.participants, currentUserId)) {
                emitError(socket, {
                    code: 403,
                    message: 'Forbidden',
                    type: 'general',
                    details: 'You are not a participant of this chat',
                });
                return;
            }

            if (await tieneBloqueoEnElGrupo(currentUserId, chat.participants)) {
                emitError(socket, emitirBloqueoDeGrupo());
                return;
            }

            // Left the chat (rejected the swap -> ended up in hiddenBy): cannot keep
            // sending. Those who stayed still chat; the conversation remains as history.
            const hiddenBy = (chat.hiddenBy || []).map((x: any) => x.toString());
            if (hiddenBy.includes(currentUserId.toString())) {
                emitError(socket, {
                    code: 403,
                    message: 'Forbidden',
                    type: 'general',
                    details: 'You left this conversation',
                });
                return;
            }

            const messageData = {
                text: msgText,
                // Attachments: only our CDN URLs (client URLs could inject arbitrary links).
                imageUrl: attachments.kept.imageUrl,
                videoUrl: attachments.kept.videoUrl,
                pdfUrl: attachments.kept.pdfUrl,
                msgByUserId: currentUserId,
                conversationId: chat?._id,
            };
            const saveMessage = await Message.create(messageData);
            notifyDroppedAttachments(socket, attachments, {
                conversationId: messageData.conversationId,
                messageId: saveMessage._id,
                clientId: data?.clientId,
            });
            const populatedMessage = await saveMessage.populate({
                path: 'msgByUserId',
                select: 'name profile_image',
            });
            // B1: emit the shared shape (helper/messageEmitShape.ts), not the raw doc,
            // same keys `get-messages` returns.
            const clientMessage = shapeSentMessage(populatedMessage);
            await Conversation.updateOne(
                { _id: chat?._id },
                {
                    lastMessage: populatedMessage._id,
                }
            );

            await Promise.all(
                chat.participants.map(async (participantId: Types.ObjectId) => {
                    const uid = participantId.toString();
                    // Those who left (hiddenBy) get neither the message nor the live
                    // re-insertion of the chat they hid.
                    if (hiddenBy.includes(uid)) return;
                    io.to(uid).emit(`message-${bondLinkId}`, clientMessage);
                    const singleConversation = await getSingleConversation(
                        chat._id.toString(),
                        uid,
                        'bondLink'
                    );
                    io.to(uid).emit('conversation', singleConversation);

                    // Refresh the participant's unread count (single source) so badge and
                    // bold update live in groups too.
                    if (uid !== currentUserId.toString()) {
                        await emitUnreadCount(io, uid);
                    }
                })
            );
        }
      } catch (err: any) {
        emitError(socket, {
            code: 500,
            message: 'Message could not be sent',
            type: 'general',
            details: err?.message || 'Internal error',
        });
      }
    });

    socket.on('seen', async ({ conversationId }) => {
      try {
        // Guards (raw NoSQL, IDOR) live in markSeen, shared with `POST /message/mark-seen`;
        // duplicating them here is how one path gets fixed and the other does not. Result
        // ignored on purpose: the socket stays silent on an invalid id or non-participant.
        await markSeen({ conversationId, currentUserId, io });
      } catch (err: any) {
        emitError(socket, {
            code: 500,
            message: 'Could not mark as seen',
            type: 'general',
            details: err?.message || 'Internal error',
        });
      }
    });
};

export default handleChat;
