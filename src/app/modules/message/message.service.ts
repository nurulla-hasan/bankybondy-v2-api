/* eslint-disable @typescript-eslint/no-explicit-any */
import Conversation from '../conversation/conversation.model';
import { buildMessagesPipeline } from './message.pipeline';
import Message from './message.model';

import httpStatus from 'http-status';
import mongoose from 'mongoose';
import AppError from '../../error/appError';
import { clampLimit, clampPage } from '../../utilities/pagination';
import { ENUM_CONVERSATION_TYPE } from '../conversation/conversation.enum';
import {
    getBlockedIdsFor,
    getBlockedObjectIdsFor,
} from '../userBlock/userBlock.service';

// Validate before constructing: `new ObjectId('abc')` throws BSONError, which is
// not CastError and escaped globalErrorHandler as a 500. With `undefined` it
// silently generates a random id, which is worse (matches nothing).
const toObjectId = (value: unknown, label: string): mongoose.Types.ObjectId => {
    const id = String(value || '');
    if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new AppError(httpStatus.BAD_REQUEST, `Invalid ${label}`);
    }
    return new mongoose.Types.ObjectId(id);
};

const getMessages = async (
    profileId: string,
    query: Record<string, unknown>
) => {
    let conversationId;
    // Prefer the explicit conversation id: works for any chat, including bond groups
    // whose bond was deleted (no bondLinkId to resolve from).
    if (query.conversationId) {
        conversationId = String(query.conversationId);
        const conversationObjectId = toObjectId(
            conversationId,
            'conversation id'
        );
        const belongs = await Conversation.findOne({
            _id: conversationObjectId,
            participants: toObjectId(profileId, 'profile id'),
        }).select('_id');
        if (!belongs) {
            throw new AppError(httpStatus.NOT_FOUND, 'Conversation not found');
        }
    } else if (query.userId) {
        const conversation = await Conversation.findOne({
            participants: {
                $all: [
                    toObjectId(profileId, 'profile id'),
                    toObjectId(query.userId, 'user id'),
                ],
            },
            type: ENUM_CONVERSATION_TYPE.oneToOne,
        });
        if (!conversation) {
            // 1-to-1 conversation that does not exist yet (no first message sent). Not an
            // error: return an empty page. A 404 here was painted as "Error loading
            // messages" and hid the optimistic bubble of a just-sent message.
            const page = clampPage(query.page);
            const limit = clampLimit(query.limit, 10, 100);
            return { meta: { page, limit, total: 0, totalPages: 0 }, result: [] };
        }
        conversationId = conversation._id.toString();
    } else if (query.chatGroupId) {
        const conversation = await Conversation.findOne({
            chatGroup: toObjectId(query.chatGroupId, 'chat group id'),
            participants: {
                $in: [toObjectId(profileId, 'profile id')],
            },
        });
        if (!conversation) {
            throw new AppError(
                httpStatus.NOT_FOUND,
                'Conversation not found for the chat group'
            );
        }
        conversationId = conversation._id.toString();
    } else if (query.bondLinkId) {
        const conversation = await Conversation.findOne({
            bondLink: toObjectId(query.bondLinkId, 'bond link id'),
            participants: {
                $in: [toObjectId(profileId, 'profile id')],
            },
        });
        if (!conversation) {
            throw new AppError(
                httpStatus.NOT_FOUND,
                'Conversation not found for the bond link'
            );
        }
        conversationId = conversation._id.toString();
    }

    const page = clampPage(query.page);
    // R3 (Tanda 0): cap the limit (anti-DoS); the shared helper also sets a floor —
    // `?page=-3` produced a NEGATIVE $skip, which Mongo rejects with a 500.
    const limit = clampLimit(query.limit, 10, 100);

    // With no resolvable id there is no conversation to query. Returning 400 would
    // change the contract (today it is a 200 with an empty page), so we return the
    // same empty shape without hitting Mongo.
    if (!conversationId) {
        return { meta: { page, limit, total: 0, totalPages: 0 }, result: [] };
    }

    const skip = (page - 1) * limit;
    const searchTerm = (query?.searchTerm as string) || '';

    // Blocking also applies to groups: messages whose author is in a block relation
    // with the viewer (either direction) are hidden, even inside a shared group.
    const blockedObjectIds = await getBlockedObjectIdsFor(profileId);

    const messages = await Message.aggregate(
        buildMessagesPipeline({
            conversationObjectId: toObjectId(conversationId, 'conversation id'),
            requesterObjectId: toObjectId(profileId, 'profile id'),
            searchTerm,
            skip,
            limit,
            blockedObjectIds,
        })
    );

    const result = messages[0]?.result || [];
    const total = messages[0]?.totalCount[0]?.total || 0;
    const totalPages = Math.ceil(total / limit);

    const response = {
        meta: {
            page,
            limit,
            total,
            totalPages,
        },
        result,
    };

    return response;
};

/**
 * Total UNREAD message count for a user (B.5): messages in the user's conversations
 * not sent by them and not in `seenBy`. Also returns a per-conversation breakdown
 * for badges.
 */
const getUnreadMessageCount = async (profileId: string) => {
    // Same as `getMessages`: a malformed profileId threw BSONError → 500, and an
    // `undefined` one generated a random id → badge stuck at 0 with no error.
    const uid = toObjectId(profileId, 'profile id');

    // Blocked ids (either direction): their 1-to-1 chats are not listed, so they must
    // not count for the badge either — that caused the "phantom badge".
    const blockedIds = new Set(await getBlockedIdsFor(profileId));

    // Conversations the user takes part in and did not hide (hiddenBy).
    const conversations = await Conversation.find({
        participants: uid,
        hiddenBy: { $ne: uid },
    })
        .select('_id type participants')
        .lean();

    // Exclude 1-to-1 chats with blocked users (same rule as the chat list) so badge
    // and list always agree.
    const visibleConversations = conversations.filter((c: any) => {
        if (c.type !== ENUM_CONVERSATION_TYPE.oneToOne) return true;
        const otherId = (c.participants || [])
            .map((p: any) => p.toString())
            .find((id: string) => id !== profileId);
        return !otherId || !blockedIds.has(otherId);
    });

    const conversationIds = visibleConversations.map((c: any) => c._id);

    if (conversationIds.length === 0) {
        return { totalUnread: 0, perConversation: [] };
    }

    const perConversation = await Message.aggregate([
        {
            $match: {
                conversationId: { $in: conversationIds },
                isDeleted: { $ne: true },
                msgByUserId: { $ne: uid },
                seenBy: { $ne: uid },
            },
        },
        {
            $group: {
                _id: '$conversationId',
                unreadCount: { $sum: 1 },
            },
        },
    ]);

    // The badge counts HOW MANY chats/groups have new messages (not the message sum)
    // so the number matches the bolded conversations in the list.
    const totalUnread = perConversation.length;

    return {
        totalUnread,
        perConversation: perConversation.map((c: any) => ({
            conversationId: c._id,
            unreadCount: c.unreadCount,
        })),
    };
};

const deleteMessage = async (messageId: string, userId: string) => {
    const message = await Message.findOne({
        _id: messageId,
        msgByUserId: userId,
    });
    if (!message) {
        throw new AppError(
            httpStatus.NOT_FOUND,
            'Message not found or you are not authorized to delete this message'
        );
    }
    const result = await Message.findByIdAndUpdate(
        messageId,
        { isDeleted: true },
        { new: true, runValidators: true }
    );
    return result;
};

const MessageService = {
    getMessages,
    deleteMessage,
    getUnreadMessageCount,
};

export default MessageService;
