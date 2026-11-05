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

    // Bloqueo: si hay bloqueo en CUALQUIER dirección, no se puede mandar solicitud.
    // Corta la solicitud y su notificación (un bloqueado no debe poder pinguearte).
    const blocked = await getBlockedIdsFor(sender);
    if (blocked.includes(receiver)) {
        throw new AppError(httpStatus.FORBIDDEN, 'No se puede enviar la solicitud');
    }

    // Validar que el receiver EXISTA y no esté bloqueado por un ADMIN. Antes solo
    // se chequeaba existencia (`exists`), así que se podía mandar solicitud (y
    // notificación) a una cuenta suspendida por moderación si se conocía su
    // profileId. Personas y el perfil individual ya la tratan como inexistente;
    // acá quedaba la puerta abierta. Se responde 404 igual, para no revelar que
    // la cuenta existe.
    const receiverAccount = await NormalUser.findById(receiver)
        .select('user')
        .populate({ path: 'user', select: 'isBlocked' })
        .lean();
    if (!receiverAccount || (receiverAccount as any).user?.isBlocked === true) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    // Duplicado en CUALQUIER sentido y solo si sigue PENDIENTE: si ya hay A→B o
    // B→A pendiente, no se crea otra (antes solo miraba el exacto A→B).
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
        // Carrera pura (doble-tap): el chequeo de arriba es check-then-create y
        // tiene ventana TOCTOU. El índice único PARCIAL {sender,receiver} con
        // status:Pending rechaza el 2do insert con E11000 → devolvemos el mismo
        // mensaje que el chequeo de duplicado (no un 500).
        if (err?.code === 11000) {
            throw new AppError(
                httpStatus.BAD_REQUEST,
                'Request already exists'
            );
        }
        throw err;
    }

    // Notificación (Fase 2): avisar al receptor de la solicitud. Best-effort.
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
    // Atómico + autorización: solo el receptor puede aceptar/rechazar,
    // y solo si sigue Pending (evita doble aceptación en carrera).
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

    // Notificación (Fase 2): si se ACEPTÓ, avisar a quien había enviado la
    // solicitud (request.sender). Best-effort, no bloquea la respuesta.
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
    // Bloqueo: excluir amistades donde la otra parte está bloqueada (cualquier
    // dirección). Como cada doc tiene sender/receiver = yo + el otro, con excluir
    // los bloqueados de ambos campos alcanza (yo nunca estoy en la lista).
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

    // Bloqueo: no mostrar solicitudes recibidas de usuarios bloqueados.
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

    // Bloqueo: no mostrar solicitudes enviadas hacia usuarios bloqueados.
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
    // Bloqueo: no contar solicitudes de usuarios bloqueados (badge fantasma).
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
