/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from 'mongoose';
import { Server as IOServer } from 'socket.io';
import NormalUser from '../modules/normalUser/normalUser.model';
import Conversation from '../modules/conversation/conversation.model';
import { ENUM_CONVERSATION_TYPE } from '../modules/conversation/conversation.enum';
import Message from '../modules/message/message.model';
import { getBlockedIdsFor } from '../modules/userBlock/userBlock.service';
import { isMessageSafe, type SafetyResult } from './isTextSafe';
import { partitionAttachmentUrls } from './attachmentUrl';
import { normalizeMessageText } from './normalizeMessageText';
import { notifyDroppedAttachments } from './attachmentNotice';
import {
    emptyMessageFailure,
    moderationFailure,
    type ErrorPayload,
} from './messageRejection';
import { getSingleConversation } from './getSingleConversation';
import { emitUnreadCount } from './emitUnreadCount';
import { shapeSentMessage } from './messageEmitShape';

export type OneToOneInput = {
    currentUserId: string;
    receiver: unknown;
    text?: unknown;
    imageUrl?: unknown;
    videoUrl?: unknown;
    pdfUrl?: unknown;
    clientId?: unknown;
    // Without `io` the message is saved but not emitted: REST must not depend on sockets.
    io?: IOServer | null;
    // Pre-computed verdict: the socket moderates before branching; REST passes none.
    moderation?: SafetyResult;
};

export type OneToOneResult = {
    // With `error` nothing was saved; otherwise the message is already stored.
    error?: ErrorPayload;
    message?: any;
    conversation?: any;
};

// One-to-one message: shared skeleton for socket `send-message` and `POST /message/send`.
// New 1-a-1 rules belong here, not in callers, so REST cannot bypass them.
export const createOneToOneMessage = async (
    input: OneToOneInput
): Promise<OneToOneResult> => {
    const { currentUserId, clientId, io } = input;
    const msgText = normalizeMessageText(input.text);

    if (msgText.trim()) {
        const verdict = input.moderation ?? (await isMessageSafe(msgText));
        const failure = moderationFailure(msgText, verdict, clientId);
        if (failure) return { error: failure };
    }

    const attachments = partitionAttachmentUrls(input);
    const failure = emptyMessageFailure(msgText, attachments, clientId);
    if (failure) return { error: failure };

    const receiverId = String(input.receiver ?? '');

    // Receiver must be valid, different from me and existing: a self-id matched any of
    // my 1-a-1 chats (phantom messages), a missing id created an orphan conversation.
    if (
        !Types.ObjectId.isValid(receiverId) ||
        receiverId === currentUserId.toString()
    ) {
        return {
            error: {
                code: 400,
                message: 'Invalid receiver',
                type: 'general',
                details: 'You must provide a valid, different receiver',
            },
        };
    }
    const receiverExists = await NormalUser.exists({ _id: receiverId });
    if (!receiverExists) {
        return {
            error: {
                code: 404,
                message: 'Receiver not found',
                type: 'general',
                details: 'The receiver user does not exist',
            },
        };
    }

    // Blocked either way: nothing is created or emitted. Groups/bondLink validate in handleChat.
    const blockedIds = await getBlockedIdsFor(currentUserId);
    if (blockedIds.includes(receiverId)) {
        return {
            error: {
                code: 403,
                message: 'You cannot message this user',
                type: 'general',
                details: 'Messaging is not allowed between blocked users',
            },
        };
    }

    // Identify 1-a-1 by its two EXACT participants ($all + size 2): loose duplicate
    // `participants:X` conditions matched any of my chats.
    let conversation = await Conversation.findOne({
        participants: { $all: [currentUserId, receiverId], $size: 2 },
        type: ENUM_CONVERSATION_TYPE.oneToOne,
    });
    if (!conversation) {
        conversation = await Conversation.create({
            participants: [currentUserId, receiverId],
            type: ENUM_CONVERSATION_TYPE.oneToOne,
        });
    }

    const messageData = {
        text: msgText,
        // Attachments: only our CDN URLs (client URLs could inject arbitrary links).
        imageUrl: attachments.kept.imageUrl,
        videoUrl: attachments.kept.videoUrl,
        pdfUrl: attachments.kept.pdfUrl,
        msgByUserId: currentUserId,
        conversationId: conversation._id,
    };
    const saveMessage = await Message.create(messageData);
    if (io) {
        notifyDroppedAttachments(io.to(currentUserId), attachments, {
            conversationId: messageData.conversationId,
            messageId: saveMessage._id,
            clientId,
        });
    }
    const populatedMessage = await saveMessage.populate({
        path: 'msgByUserId',
        select: 'name profile_image',
    });

    // B1: delivered shape (socket and REST) comes from the shared helper, not the raw
    // doc; see helper/messageEmitShape.ts for why `isMyMessage`/`seen` stay out.
    const clientMessage = shapeSentMessage(populatedMessage);

    // UNHIDE both sides: a hidden chat stayed invisible forever, so sending or receiving
    // never brought it back. Hiding orders the list, it does not mute (that is blocking).
    // 1-a-1 only: in bondLink, `hiddenBy` is deliberate (rejecting a swap removes you).
    // The explicit ObjectId cast is defensive redundancy; upstream validation is the guard.
    await Conversation.updateOne(
        { _id: conversation._id },
        {
            $set: { lastMessage: saveMessage._id },
            $pull: {
                hiddenBy: {
                    $in: [
                        new Types.ObjectId(currentUserId),
                        new Types.ObjectId(receiverId),
                    ],
                },
            },
        }
    );

    // Ids are validated above; event name and room come from them, not from client input.
    if (io) {
        io.to(currentUserId.toString()).emit(
            `message-${receiverId}`,
            clientMessage
        );
        io.to(receiverId).emit(`message-${currentUserId}`, clientMessage);

        const conversationSender = await getSingleConversation(
            conversation._id.toString(),
            currentUserId,
            'participants'
        );
        const conversationReceiver = await getSingleConversation(
            conversation._id.toString(),
            receiverId,
            'participants'
        );
        io.to(currentUserId.toString()).emit('conversation', conversationSender);
        io.to(receiverId).emit('conversation', conversationReceiver);

        await emitUnreadCount(io, receiverId);
    }

    return { message: clientMessage, conversation };
};
