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
    query: Record<string, unknown>
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
    // R3 (Tanda 0): cap del limit del listado de chats (anti-DoS). Se capa a 500,
    // no a 100: el front trae TODA la lista en una tira sin paginar (CHAT_LIST_LIMIT
    // = 500 en useConversationsList); 100 rompería el sidebar de usuarios con >100
    // chats. 500 frena el DoS (limit=999999) sin regresión. El skip se recalcula
    // con el limit capado para que la paginación quede coherente.
    const limit = Math.min(Number(rawLimit) || 10, 500);
    const skip = ((Number(page) || 1) - 1) * limit;
    const sortConditions: { [key: string]: 1 | -1 } = {};
    if (sortBy && sortOrder) {
        sortConditions[sortBy] = sortOrder === 'asc' ? 1 : -1;
    }

    // Bloqueo (B.4): ids que el usuario bloqueo + que lo bloquearon. Se usan
    // para ocultar de la lista las conversaciones 1-a-1 con esos usuarios.
    // No se borran datos: solo se filtra la salida.
    const blockedObjectIds = await getBlockedObjectIdsFor(profileId);

    const searchConditions = [];
    if (searchTerm) {
        searchConditions.push({
            $or: [
                { 'userData.name': { $regex: escapeRegex(searchTerm), $options: 'i' } },
                { 'userData.email': { $regex: escapeRegex(searchTerm), $options: 'i' } },
                { 'project.title': { $regex: escapeRegex(searchTerm), $options: 'i' } },
                { 'project.name': { $regex: escapeRegex(searchTerm), $options: 'i' } },
                { 'chatGroup.name': { $regex: escapeRegex(searchTerm), $options: 'i' } },
                { 'bondLink.name': { $regex: escapeRegex(searchTerm), $options: 'i' } },
            ],
        });
    }

    const pipeline: any[] = [
        {
            $match: {
                participants: new Types.ObjectId(profileId),
                // B.7 (Tanda 2): excluir del listado las conversaciones que ESTE
                // usuario oculto (soft-hide). No afecta al otro participante.
                hiddenBy: { $ne: new Types.ObjectId(profileId) },
                // PARKEADO (objects apagado): desmontar /project del router NO
                // alcanzaba. Estas conversaciones seguían apareciendo en la lista
                // de chats y dejaban entrar al chat del objeto por la puerta de
                // atrás. Se excluyen acá. Reactivar objects = borrar esta línea.
                type: { $ne: ENUM_CONVERSATION_TYPE.projectGroup },
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
        // La vista previa no puede dejar el contenido de un mensaje borrado:
        // acá es donde se corta, para que la lista de chats no sea la puerta
        // que salta el vaciado que `getMessages` ya hace.
        scrubLastMessageStage(),
        {
            $lookup: {
                from: 'projects',
                localField: 'project',
                foreignField: '_id',
                as: 'project',
            },
        },
        {
            $unwind: {
                path: '$project',
                preserveNullAndEmptyArrays: true,
            },
        },
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
        // Bloqueo (B.4): excluir de la lista las conversaciones 1-a-1 cuyo otro
        // participante esta bloqueado (en cualquier sentido). Solo afecta 1-a-1;
        // grupos/proyectos/bondLink pasan intactos.
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
        // C.5 (Tanda 2): ocultar del listado las conversaciones 1-a-1 cuyo otro
        // participante fue bloqueado por un admin (User.isBlocked = true). Se
        // resuelve el User via NormalUser.user y se filtra. Grupos/proyectos/
        // bond-link NO se ven afectados (misma politica que el bloqueo P2P).
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
            // Integrantes del chat (todos los participantes) con nombre y foto,
            // para mostrar avatares apilados + nombres en la UI.
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
                                    // Un mensaje BORRADO no cuenta como no leido.
                                    // El contador global del navbar sí lo filtra;
                                    // sin esto los dos numeros se contradecian y
                                    // quedaba una conversacion en negrita con
                                    // badge apuntando a un mensaje inexistente.
                                    {
                                        $ne: [
                                            { $ifNull: ['$isDeleted', false] },
                                            true,
                                        ],
                                    },
                                    // Unificado sobre `seenBy`: no leido si el
                                    // usuario no esta en el array seenBy.
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
                    // El EMAIL se sacó de la proyección: el chat 1-a-1 no exige
                    // amistad, así que cualquiera podía abrir una conversación con
                    // cualquier perfil y leerle el mail acá. Los perfiles públicos
                    // ya recortan ese dato; esta era la puerta que quedaba abierta.
                    // El front no lo usa (verificado), así que no rompe nada.
                    name: '$otherUser.name',
                    profile_image: '$otherUser.profile_image',
                },

                project: {
                    _id: 1,
                    name: 1,
                    cover_image: 1,
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

const getConversationMediaFiles = async (
    profileId: string,
    conversationId: string,
    query: Record<string, unknown>
) => {
    // R3 (Tanda 0): cap del limit (anti-DoS). Ahora por el helper común, que
    // además pone PISO: el `Number(query.page) || 1` pelado dejaba pasar `-3`
    // (skip negativo → Mongo lo rechaza → 500) y `1e999` (Infinity → ídem), y el
    // `Math.min(..., 100)` no protegía de un `?limit=-5` (queda -5, también 500).
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit, 20, 100);
    const skip = (page - 1) * limit;

    const conversation = await Conversation.findOne({
        participants: profileId,
        _id: conversationId,
        // PARKEADO (objects apagado): faltaba esta línea. Se cerraron la lista de
        // chats, los mensajes y el contador de no leídos, pero los ADJUNTOS
        // seguían accesibles: con el id de una conversación de objeto vieja, un
        // participante podía listar sus fotos y archivos. Reactivar objects =
        // borrar esta línea (igual que en las otras tres).
        type: { $ne: ENUM_CONVERSATION_TYPE.projectGroup },
    });

    if (!conversation) {
        throw new AppError(
            httpStatus.UNAUTHORIZED,
            'Conversation not found or access denied'
        );
    }

    // Mismos filtros que getMessages: la galería NO debe mostrar adjuntos de
    // mensajes BORRADOS (isDeleted) ni de usuarios BLOQUEADOS (el bloqueo alcanza
    // a los grupos). Antes el $match solo filtraba por conversación → leak.
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
        // `urls` queda EXACTAMENTE como estaba (misma lista, mismo orden); la
        // clave nueva es `items`, con el mensaje y la fecha de cada adjunto.
        urls: urlsFromItems(items),
        items,
    };
};

/**
 * B.7 (Tanda 2) - Ocultar/des-ocultar una conversacion SOLO para el usuario
 * actual (soft-hide por participante). No borra datos ni afecta al otro.
 * @param hide true => ocultar (agrega a hiddenBy); false => des-ocultar.
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

    // El usuario debe ser participante de la conversacion.
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
    getConversationMediaFiles,
    setConversationHidden,
};

export default ConversationService;
