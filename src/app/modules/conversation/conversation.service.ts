/* eslint-disable @typescript-eslint/no-explicit-any */
import mongoose, { Types } from 'mongoose';
import { escapeRegex } from '../../utilities/escapeRegex';
import { clampLimit, clampPage } from '../../utilities/pagination';

import httpStatus from 'http-status';
import AppError from '../../error/appError';
import calculatePagination from '../../helper/paginationHelper';
import pick from '../../helper/pick';
import { scrubLastMessageStage } from '../../helper/scrubDeletedPreview';
import Message from '../message/message.model';
import { getBlockedObjectIdsFor } from '../userBlock/userBlock.service';
import { ENUM_CONVERSATION_TYPE } from './conversation.enum';
import Conversation from './conversation.model';
import {
    buildMediaGalleryPipeline,
    urlsFromItems,
    type MediaItem,
} from './media.pipeline';

const getConversation = async (
    profileId: string,
    query: Record<string, unknown>,
    // The normal list omits what THIS user hid; the "hidden chats" screen is the
    // same list with the filter inverted, so both share the pipeline and can't
    // diverge in shape or blocking rules.
    hidden = false
) => {
    const filters = pick(query, ['searchTerm', 'email', 'name']);

    const paginationOptions = pick(query, [
        'page',
        'limit',
        'sortBy',
        'sortOrder',
    ]);

    const { searchTerm } = filters;

    const {
        page,
        limit: rawLimit = 10,
        sortBy,
        sortOrder,
    } = calculatePagination(paginationOptions);
    // R3: chat-list limit cap (anti-DoS). 500, not 100: the front loads the whole
    // list unpaginated (CHAT_LIST_LIMIT = 500), so 100 would break the sidebar of
    // users with >100 chats. Skip uses the capped limit to keep pagination coherent.
    const limit = Math.min(Number(rawLimit) || 10, 500);
    const skip = ((Number(page) || 1) - 1) * limit;
    const sortConditions: { [key: string]: 1 | -1 } = {};
    if (sortBy && sortOrder) {
        sortConditions[sortBy] = sortOrder === 'asc' ? 1 : -1;
    }

    // Blocking (B.4): ids the user blocked + those that blocked them, used to hide
    // 1-to-1 conversations with those users. No data deleted, only output filtered.
    const blockedObjectIds = await getBlockedObjectIdsFor(profileId);

    const searchConditions = [];
    if (searchTerm) {
        searchConditions.push({
            $or: [
                { 'userData.name': { $regex: escapeRegex(searchTerm), $options: 'i' } },
                { 'userData.email': { $regex: escapeRegex(searchTerm), $options: 'i' } },
                { 'chatGroup.name': { $regex: escapeRegex(searchTerm), $options: 'i' } },
                { 'bondLink.name': { $regex: escapeRegex(searchTerm), $options: 'i' } },
            ],
        });
    }

    const pipeline: any[] = [
        {
            $match: {
                participants: new Types.ObjectId(profileId),
                // B.7: exclude conversations THIS user hid (soft-hide); doesn't
                // affect the other participant. `hidden` inverts it for the hidden screen.
                hiddenBy: hidden
                    ? new Types.ObjectId(profileId)
                    : { $ne: new Types.ObjectId(profileId) },
            },
        },
        {
            $lookup: {
                from: 'messages',
                localField: 'lastMessage',
                foreignField: '_id',
                as: 'lastMessage',
            },
        },
        {
            $unwind: {
                path: '$lastMessage',
                preserveNullAndEmptyArrays: true,
            },
        },
        // The preview must not expose a deleted message's content: cut it here so
        // the chat list isn't a second door around the scrubbing `getMessages` does.
        scrubLastMessageStage(),
        {
            $lookup: {
                from: 'chatgroups',
                localField: 'chatGroup',
                foreignField: '_id',
                as: 'chatGroup',
            },
        },
        {
            $unwind: {
                path: '$chatGroup',
                preserveNullAndEmptyArrays: true,
            },
        },
        {
            $lookup: {
                from: 'bondlinks',
                localField: 'bondLink',
                foreignField: '_id',
                as: 'bondLink',
            },
        },
        {
            $unwind: {
                path: '$bondLink',
                preserveNullAndEmptyArrays: true,
            },
        },

        {
            $lookup: {
                from: 'normalusers',
                let: { participants: '$participants' },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $and: [
                                    { $in: ['$_id', '$$participants'] },
                                    {
                                        $ne: [
                                            '$_id',
                                            new Types.ObjectId(profileId),
                                        ],
                                    },
                                ],
                            },
                        },
                    },
                    { $limit: 1 },
                ],
                as: 'otherUser',
            },
        },
        {
            $unwind: {
                path: '$otherUser',
                preserveNullAndEmptyArrays: true, // keep the doc even if no otherUser
            },
        },
        // Blocking (B.4): exclude 1-to-1 conversations whose other participant is
        // blocked (either direction). Groups/projects/bondLink pass through untouched.
        ...(blockedObjectIds.length > 0
            ? [
                  {
                      $match: {
                          $nor: [
                              {
                                  type: ENUM_CONVERSATION_TYPE.oneToOne,
                                  'otherUser._id': { $in: blockedObjectIds },
                              },
                          ],
                      },
                  },
              ]
            : []),
        // C.5: also hide 1-to-1 conversations whose other participant was blocked by
        // an admin (User.isBlocked, resolved via NormalUser.user). Groups/projects/
        // bond-link are unaffected — same policy as P2P blocking.
        {
            $lookup: {
                from: 'users',
                localField: 'otherUser.user',
                foreignField: '_id',
                as: 'otherUserAccount',
            },
        },
        {
            $unwind: {
                path: '$otherUserAccount',
                preserveNullAndEmptyArrays: true,
            },
        },
        {
            $match: {
                $nor: [
                    {
                        type: ENUM_CONVERSATION_TYPE.oneToOne,
                        'otherUserAccount.isBlocked': true,
                    },
                ],
            },
        },
        {
            // Chat members with name and photo, for stacked avatars + names in the UI.
            $lookup: {
                from: 'normalusers',
                localField: 'participants',
                foreignField: '_id',
                as: 'members',
            },
        },
        {
            $lookup: {
                from: 'messages',
                let: { conversationId: '$_id' },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $and: [
                                    {
                                        $eq: [
                                            '$conversationId',
                                            '$$conversationId',
                                        ],
                                    },
                                    // A DELETED message doesn't count as unread (the
                                    // navbar counter filters it too, else the two disagreed).
                                    {
                                        $ne: [
                                            { $ifNull: ['$isDeleted', false] },
                                            true,
                                        ],
                                    },
                                    // Unified on `seenBy`: unread if the user isn't in it.
                                    {
                                        $not: {
                                            $in: [
                                                new mongoose.Types.ObjectId(
                                                    profileId
                                                ),
                                                {
                                                    $ifNull: ['$seenBy', []],
                                                },
                                            ],
                                        },
                                    },
                                    {
                                        $ne: [
                                            '$msgByUserId',
                                            new mongoose.Types.ObjectId(
                                                profileId
                                            ),
                                        ],
                                    },
                                ],
                            },
                        },
                    },
                    {
                        $count: 'unreadCount',
                    },
                ],
                as: 'unreadCountData',
            },
        },
        {
            $unwind: {
                path: '$unreadCountData',
                preserveNullAndEmptyArrays: true,
            },
        },
        {
            $project: {
                _id: 1,
                type: '$type',
                userData: {
                    _id: '$otherUser._id',
                    // EMAIL was dropped from the projection: 1-to-1 chat needs no
                    // friendship, so anyone could open a conversation with any profile
                    // and read their mail here. Public profiles already trim it, and
                    // the front doesn't use it (verified).
                    name: '$otherUser.name',
                    profile_image: '$otherUser.profile_image',
                },

                chatGroup: {
                    _id: 1,
                    name: 1,
                    image: 1,
                },
                bondLink: {
                    _id: 1,
                    name: 1,
                    status: 1,
                },
                lastMessage: 1,
                created_at: '$createdAt',
                updated_at: '$updatedAt',
                unseenMsg: { $ifNull: ['$unreadCountData.unreadCount', 0] },
                members: {
                    $map: {
                        input: '$members',
                        as: 'm',
                        in: {
                            _id: '$$m._id',
                            name: '$$m.name',
                            profile_image: '$$m.profile_image',
                        },
                    },
                },
            },
        },

        ...(searchConditions.length > 0
            ? [{ $match: { $and: searchConditions } }]
            : []),
        {
            $sort: { updated_at: -1 },
        },
        { $skip: skip },
        { $limit: limit },
    ];

    const [results, totalCount] = await Promise.all([
        Conversation.aggregate(pipeline),
        Conversation.aggregate([...pipeline.slice(0, -2), { $count: 'total' }]),
    ]);
    const total = totalCount[0]?.total || 0;
    return {
        meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
        data: results,
    };
};

const getHiddenConversations = async (
    profileId: string,
    query: Record<string, unknown>
) => getConversation(profileId, query, true);

const getConversationMediaFiles = async (
    profileId: string,
    conversationId: string,
    query: Record<string, unknown>
) => {
    // R3: limit cap (anti-DoS) via the shared clamp helper, which also sets a floor
    // (bare `Number(page) || 1` let -3 and 1e999 through → Mongo rejected → 500).
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit, 20, 100);
    const skip = (page - 1) * limit;

    const conversation = await Conversation.findOne({
        participants: profileId,
        _id: conversationId,
    });

    if (!conversation) {
        throw new AppError(
            httpStatus.UNAUTHORIZED,
            'Conversation not found or access denied'
        );
    }

    // Same filters as getMessages: the gallery must not show attachments from
    // DELETED messages or BLOCKED users (blocking reaches groups). The old $match leaked them.
    const blockedObjectIds = await getBlockedObjectIdsFor(profileId);
    const [result] = await Message.aggregate(
        buildMediaGalleryPipeline({
            conversationObjectId: new mongoose.Types.ObjectId(conversationId),
            blockedObjectIds,
            skip,
            limit,
        })
    );

    const items: MediaItem[] = result.paginatedResults[0]?.items || [];
    const totalUrls = result.totalCount[0]?.count || 0;
    const totalPages = Math.ceil(totalUrls / limit);

    return {
        meta: {
            page,
            limit,
            totalPages: totalPages,
            total: totalUrls,
        },
        // `urls` stays exactly as before (same list, same order); `items` is new.
        urls: urlsFromItems(items),
        items,
    };
};

/**
 * B.7 - Hide/unhide a conversation for the current user only (per-participant
 * soft-hide). Deletes nothing and doesn't affect the other side.
 * @param hide true => hide (add to hiddenBy); false => unhide.
 */
const setConversationHidden = async (
    profileId: string,
    conversationId: string,
    hide: boolean
) => {
    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid conversation id');
    }

    const profileObjectId = new Types.ObjectId(profileId);

    // The user must be a participant of the conversation.
    const conversation = await Conversation.findOne({
        _id: conversationId,
        participants: profileObjectId,
    }).select('_id');

    if (!conversation) {
        throw new AppError(
            httpStatus.NOT_FOUND,
            'Conversation not found or access denied'
        );
    }

    const update = hide
        ? { $addToSet: { hiddenBy: profileObjectId } }
        : { $pull: { hiddenBy: profileObjectId } };

    const result = await Conversation.findByIdAndUpdate(
        conversationId,
        update,
        { new: true }
    ).select('_id hiddenBy');

    return result;
};

const ConversationService = {
    getConversation,
    getHiddenConversations,
    getConversationMediaFiles,
    setConversationHidden,
};

export default ConversationService;
