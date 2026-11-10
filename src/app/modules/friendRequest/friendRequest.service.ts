/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import { clampLimit, clampPage } from '../../utilities/pagination';
import { escapeRegex } from '../../utilities/escapeRegex';
import mongoose from 'mongoose';
import AppError from '../../error/appError';
import { ENUM_FRIEND_REQUEST_STATUS } from './friendRequest.enum';
import FriendRequest from './friendRequest.model';
import NormalUser from '../normalUser/normalUser.model';
import sendNotification from '../../helper/sendNotification';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';
import {
    getBlockedIdsFor,
    getBlockedObjectIdsFor,
} from '../userBlock/userBlock.service';
type ENUM_FRIEND_REQUEST_STATUS = keyof typeof ENUM_FRIEND_REQUEST_STATUS;
const sendFriendRequest = async (sender: string, receiver: string) => {
    if (sender === receiver)
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Cannot send request to self'
        );

    // Blocking in EITHER direction stops the request and its notification.
    const blocked = await getBlockedIdsFor(sender);
    if (blocked.includes(receiver)) {
        throw new AppError(httpStatus.FORBIDDEN, 'No se puede enviar la solicitud');
    }

    // Receiver must exist and not be admin-blocked. Respond 404 either way so we
    // don't reveal that a suspended account exists.
    const receiverAccount = await NormalUser.findById(receiver)
        .select('user')
        .populate({ path: 'user', select: 'isBlocked' })
        .lean();
    if (!receiverAccount || (receiverAccount as any).user?.isBlocked === true) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    // Duplicate in ANY direction, and only while still Pending.
    const existing = await FriendRequest.findOne({
        status: ENUM_FRIEND_REQUEST_STATUS.Pending,
        $or: [
            { sender, receiver },
            { sender: receiver, receiver: sender },
        ],
    });
    if (existing)
        throw new AppError(httpStatus.BAD_REQUEST, 'Request already exists');

    let created;
    try {
        created = await FriendRequest.create({ sender, receiver });
    } catch (err: any) {
        // Pure race (double-tap): the partial unique index rejects the 2nd insert
        // with E11000 -> return the same message as the duplicate check, not a 500.
        if (err?.code === 11000) {
            throw new AppError(
                httpStatus.BAD_REQUEST,
                'Request already exists'
            );
        }
        throw err;
    }

    // Notify the receiver of the request. Best-effort.
    sendNotification({
        title: 'Nueva solicitud de amistad',
        message: 'Alguien quiere sumarte como amistad.',
        receiver: String(receiver),
        type: ENUM_NOTIFICATION_TYPE.FRIEND_REQUEST,
        redirectId: String(sender),
    }).catch(() => undefined);

    return created;
};

const acceptRejectRequest = async (
    requestId: string,
    status: ENUM_FRIEND_REQUEST_STATUS,
    receiver: string
) => {
    // Atomic + authorization: only the receiver, and only while still Pending
    // (prevents double acceptance in a race).
    const request = await FriendRequest.findOneAndUpdate(
        {
            _id: requestId,
            receiver,
            status: ENUM_FRIEND_REQUEST_STATUS.Pending,
        },
        { status },
        { new: true }
    );
    if (!request) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Invalid or already handled request'
        );
    }

    // If ACCEPTED, notify the original sender. Best-effort, never blocks the response.
    if (String(status) === ENUM_FRIEND_REQUEST_STATUS.Accepted) {
        sendNotification({
            title: 'Aceptaron tu solicitud',
            message: 'Ya son amistades. Pasá a saludar.',
            receiver: request.sender.toString(),
            type: ENUM_NOTIFICATION_TYPE.FRIEND_ACCEPTED,
            redirectId: String(receiver),
        }).catch(() => undefined);
    }

    return request;
};

const getMyFriends = async (userId: string, query: Record<string, any>) => {
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit);
    const skip = (page - 1) * limit;
    const searchTerm = query.searchTerm || '';
    // Exclude friendships where the other party is blocked (either direction).
    // Each doc is me + the other, so filtering both fields suffices.
    const blockedIds = await getBlockedObjectIdsFor(userId);
    const matchStage: any = {
        $or: [
            {
                sender: new mongoose.Types.ObjectId(userId),
                status: ENUM_FRIEND_REQUEST_STATUS.Accepted,
            },
            {
                receiver: new mongoose.Types.ObjectId(userId),
                status: ENUM_FRIEND_REQUEST_STATUS.Accepted,
            },
        ],
        sender: { $nin: blockedIds },
        receiver: { $nin: blockedIds },
    };

    const searchMatchStage = searchTerm
        ? {
              $or: [
                  { 'senderInfo.name': { $regex: escapeRegex(searchTerm), $options: 'i' } },
                  {
                      'receiverInfo.name': {
                          $regex: escapeRegex(searchTerm),
                          $options: 'i',
                      },
                  },
              ],
              $nor: [{ sender: userId }, { receiver: userId }],
          }
        : { $nor: [{ sender: userId }, { receiver: userId }] };

    const pipeline: any[] = [
        { $match: matchStage },
        {
            $lookup: {
                from: 'normalusers',
                localField: 'sender',
                foreignField: '_id',
                as: 'senderInfo',
            },
        },
        {
            $lookup: {
                from: 'normalusers',
                localField: 'receiver',
                foreignField: '_id',
                as: 'receiverInfo',
            },
        },
        { $unwind: { path: '$senderInfo', preserveNullAndEmptyArrays: true } },
        {
            $unwind: {
                path: '$receiverInfo',
                preserveNullAndEmptyArrays: true,
            },
        },

        {
            $lookup: {
                from: 'skills',
                localField: 'senderInfo.skills',
                foreignField: '_id',
                as: 'senderInfo.skills',
            },
        },
        {
            $lookup: {
                from: 'skills',
                localField: 'receiverInfo.skills',
                foreignField: '_id',
                as: 'receiverInfo.skills',
            },
        },
        { $match: searchMatchStage },
        {
            $facet: {
                meta: [{ $count: 'total' }],
                result: [
                    {
                        $project: {
                            _id: 1,
                            status: 1,
                            createdAt: 1,
                            updatedAt: 1,
                            friendInfo: {
                                $cond: {
                                    if: {
                                        $eq: [
                                            '$sender',
                                            new mongoose.Types.ObjectId(userId),
                                        ],
                                    },
                                    then: {
                                        _id: '$receiverInfo._id',
                                        name: '$receiverInfo.name',
                                        profile_image:
                                            '$receiverInfo.profile_image',
                                        skills: {
                                            $map: {
                                                input: '$receiverInfo.skills',
                                                as: 's',
                                                in: '$$s.name',
                                            },
                                        },
                                    },
                                    else: {
                                        _id: '$senderInfo._id',
                                        name: '$senderInfo.name',
                                        profile_image:
                                            '$senderInfo.profile_image',
                                        skills: {
                                            $map: {
                                                input: '$senderInfo.skills',
                                                as: 's',
                                                in: '$$s.name',
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    { $sort: { createdAt: -1 } },
                    { $skip: skip },
                    { $limit: limit },
                ],
            },
        },
    ];

    const aggResult = await FriendRequest.aggregate(pipeline);
    const result = aggResult[0]?.result || [];
    const total = aggResult[0]?.meta[0]?.total || 0;
    const totalPages = Math.ceil(total / limit);
    return {
        meta: {
            page,
            limit,
            total,
            totalPages,
        },
        result,
    };
};

const getMyFollowers = async (userId: string, query: Record<string, any>) => {
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit);
    const skip = (page - 1) * limit;
    const searchTerm = query.searchTerm || '';

    // Don't show incoming requests from blocked users.
    const blockedIds = await getBlockedObjectIdsFor(userId);
    const matchStage: any = {
        receiver: new mongoose.Types.ObjectId(userId),
        status: ENUM_FRIEND_REQUEST_STATUS.Pending,
        sender: { $nin: blockedIds },
    };

    const searchMatchStage = searchTerm
        ? {
              'senderInfo.name': { $regex: escapeRegex(searchTerm), $options: 'i' },
          }
        : {};

    const pipeline: any[] = [
        { $match: matchStage },
        {
            $lookup: {
                from: 'normalusers',
                localField: 'sender',
                foreignField: '_id',
                as: 'senderInfo',
            },
        },
        { $unwind: { path: '$senderInfo', preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: 'skills',
                localField: 'senderInfo.skills',
                foreignField: '_id',
                as: 'senderInfo.skills',
            },
        },
        { $match: searchMatchStage },
        {
            $facet: {
                meta: [{ $count: 'total' }],
                result: [
                    {
                        $project: {
                            _id: 1,
                            status: 1,
                            createdAt: 1,
                            updatedAt: 1,
                            followerInfo: {
                                _id: '$senderInfo._id',
                                name: '$senderInfo.name',
                                profile_image: '$senderInfo.profile_image',
                                skills: {
                                    $map: {
                                        input: '$senderInfo.skills',
                                        as: 's',
                                        in: '$$s.name',
                                    },
                                },
                            },
                        },
                    },
                    { $sort: { createdAt: -1 } },
                    { $skip: skip },
                    { $limit: limit },
                ],
            },
        },
    ];

    const aggResult = await FriendRequest.aggregate(pipeline);
    const result = aggResult[0]?.result || [];
    const total = aggResult[0]?.meta[0]?.total || 0;
    const totalPages = Math.ceil(total / limit);

    return {
        meta: {
            page,
            limit,
            total,
            totalPages,
        },
        result,
    };
};

const getMyFollowing = async (userId: string, query: Record<string, any>) => {
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit);
    const skip = (page - 1) * limit;
    const searchTerm = query.searchTerm || '';

    // Don't show sent requests toward blocked users.
    const blockedIds = await getBlockedObjectIdsFor(userId);
    const matchStage: any = {
        sender: new mongoose.Types.ObjectId(userId),
        status: ENUM_FRIEND_REQUEST_STATUS.Pending,
        receiver: { $nin: blockedIds },
    };

    const searchMatchStage = searchTerm
        ? { 'receiverInfo.name': { $regex: escapeRegex(searchTerm), $options: 'i' } }
        : {};

    const pipeline: any[] = [
        { $match: matchStage },
        {
            $lookup: {
                from: 'normalusers',
                localField: 'receiver',
                foreignField: '_id',
                as: 'receiverInfo',
            },
        },
        {
            $unwind: {
                path: '$receiverInfo',
                preserveNullAndEmptyArrays: true,
            },
        },
        {
            $lookup: {
                from: 'skills',
                localField: 'receiverInfo.skills',
                foreignField: '_id',
                as: 'receiverInfo.skills',
            },
        },
        { $match: searchMatchStage },
        {
            $facet: {
                meta: [{ $count: 'total' }],
                result: [
                    {
                        $project: {
                            _id: 1,
                            status: 1,
                            createdAt: 1,
                            updatedAt: 1,
                            followingInfo: {
                                _id: '$receiverInfo._id',
                                name: '$receiverInfo.name',
                                profile_image: '$receiverInfo.profile_image',
                                skills: {
                                    $map: {
                                        input: '$receiverInfo.skills',
                                        as: 's',
                                        in: '$$s.name',
                                    },
                                },
                            },
                        },
                    },
                    { $sort: { createdAt: -1 } },
                    { $skip: skip },
                    { $limit: limit },
                ],
            },
        },
    ];

    const aggResult = await FriendRequest.aggregate(pipeline);
    const result = aggResult[0]?.result || [];
    const total = aggResult[0]?.meta[0]?.total || 0;
    const totalPages = Math.ceil(total / limit);

    return {
        meta: {
            page,
            limit,
            total,
            totalPages,
        },
        result,
    };
};

const cancelSentRequest = async (sender: string, receiver: string) => {
    return await FriendRequest.findOneAndDelete({
        sender,
        receiver,
        status: ENUM_FRIEND_REQUEST_STATUS.Pending,
    });
};

const unfriend = async (userId: string, friendId: string) => {
    console.log('userid', userId, friendId);
    return await FriendRequest.findOneAndDelete({
        $or: [
            {
                sender: userId,
                receiver: friendId,
                status: ENUM_FRIEND_REQUEST_STATUS.Accepted,
            },
            {
                sender: friendId,
                receiver: userId,
                status: ENUM_FRIEND_REQUEST_STATUS.Accepted,
            },
        ],
    });
};

const getPendingRequestCount = async (userId: string) => {
    // Don't count requests from blocked users (phantom badge).
    const blockedIds = await getBlockedObjectIdsFor(userId);
    const count = await FriendRequest.countDocuments({
        receiver: new mongoose.Types.ObjectId(userId),
        status: ENUM_FRIEND_REQUEST_STATUS.Pending,
        sender: { $nin: blockedIds },
    });
    return { count };
};

const friendRequestService = {
    sendFriendRequest,
    acceptRejectRequest,
    getMyFriends,
    getMyFollowers,
    getMyFollowing,
    cancelSentRequest,
    unfriend,
    getPendingRequestCount,
};

export default friendRequestService;
