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

// Construye un ObjectId validando ANTES. `new mongoose.Types.ObjectId('abc')`
// tira BSONError, que NO es CastError y por lo tanto NO lo atrapa ninguna rama
// del globalErrorHandler → salía 500 en vez de 400. (Ojo: con `undefined` no
// tira: genera un id NUEVO al azar, que es peor todavía porque el `$match` no
// falla, simplemente no matchea nada en silencio.)
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
    // Preferimos el id directo de la conversacion cuando el front lo manda: sirve
    // para CUALQUIER chat, incluidos grupos de vinculo cuyo bond fue borrado (que
    // no tienen bondLinkId para resolverse). Antes esos chats no cargaban mensajes.
    if (query.conversationId) {
        conversationId = String(query.conversationId);
        const conversationObjectId = toObjectId(
            conversationId,
            'conversation id'
        );
        const belongs = await Conversation.findOne({
            _id: conversationObjectId,
            participants: toObjectId(profileId, 'profile id'),
            // PARKEADO (objects apagado): validar solo la membresía dejaba que un
            // participante leyera el chat de un objeto pasando su conversationId
            // directo. Reactivar objects = borrar esta línea.
            type: { $ne: ENUM_CONVERSATION_TYPE.projectGroup },
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
            // Conversación 1-a-1 que TODAVÍA no existe: llegaste desde Personas/un
            // perfil y aún no escribiste el primer mensaje. NO es un error, solo no
            // hay mensajes. Antes tiraba 404 → el front lo pintaba como "Error al
            // cargar los mensajes" y ese branch tapaba la burbuja optimista del
            // mensaje recién enviado (había que reabrir el chat desde la lista para
            // que cargara por conversationId). Devolvemos una página vacía con el
            // mismo shape; al enviar el primer mensaje se crea la conversación y el
            // refetch (invalidación de CONVERSATIONS) ya trae el historial real.
            const page = clampPage(query.page);
            const limit = clampLimit(query.limit, 10, 100);
            return { meta: { page, limit, total: 0, totalPages: 0 }, result: [] };
        }
        conversationId = conversation._id.toString();
    } else if (query.projectId) {
        // PARKEADO (objects apagado): esta rama resolvía el chat de un objeto a
        // partir de su projectId. Con /project desmontado seguía siendo la puerta
        // más directa para leer esos mensajes. Reactivar objects = borrar el
        // throw y descomentar el bloque de abajo ("solo cablear").
        throw new AppError(
            httpStatus.FORBIDDEN,
            'Los objetos están deshabilitados.'
        );
        // const conversation = await Conversation.findOne({
        //     project: new mongoose.Types.ObjectId(query.projectId as string),
        //     participants: {
        //         $in: [new mongoose.Types.ObjectId(profileId)],
        //     },
        // });
        // if (!conversation) {
        //     throw new AppError(
        //         httpStatus.NOT_FOUND,
        //         'Conversation not found for the project'
        //     );
        // }
        // conversationId = conversation._id.toString();
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
    // R3 (Tanda 0): cap del limit (anti-DoS). Antes `limit=999999` traía TODO el
    // historial en una sola query. Ahora por el helper común, que ademas pone piso:
    // `?page=-3` daba un `$skip` NEGATIVO y Mongo lo rechaza → era un 500.
    const limit = clampLimit(query.limit, 10, 100);

    // Sin NINGÚN id resoluble (ni conversationId, ni userId, ni chatGroupId, ni
    // bondLinkId) no hay conversación que consultar. ChatGPT proponía tirar 400 acá,
    // pero eso CAMBIA EL CONTRATO: hoy este request devuelve 200 con página vacía
    // (abajo, `new ObjectId(undefined)` genera un id al azar que no matchea nada), y
    // la app nativa no está en este repo para comprobar que no dependa de eso.
    // Devolvemos el MISMO shape vacío que ya usa la rama de "conversación 1-a-1 que
    // todavía no existe", pero cortando antes de pegarle a Mongo al pedo.
    if (!conversationId) {
        return { meta: { page, limit, total: 0, totalPages: 0 }, result: [] };
    }

    const skip = (page - 1) * limit;
    const searchTerm = (query?.searchTerm as string) || '';

    // El bloqueo alcanza a los grupos: los mensajes cuyo autor esta en relacion
    // de bloqueo con quien mira (en cualquier sentido) se ocultan, incluso
    // dentro de un grupo compartido. En los 1-a-1 la conversacion ya no aparece
    // en la lista, asi que filtrar sus mensajes no cambia lo visible.
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
 * Conteo total de mensajes NO leidos del usuario (B.5).
 * Un mensaje cuenta como no leido si: pertenece a una conversacion donde el
 * usuario participa, NO lo envio el propio usuario, y su id no esta en `seenBy`.
 * Devuelve tambien el desglose por conversacion para pintar badges.
 */
const getUnreadMessageCount = async (profileId: string) => {
    // Mismo criterio que `getMessages`: un profileId malformado tiraba BSONError
    // → 500, y uno `undefined` generaba un id NUEVO al azar → el badge quedaba
    // clavado en 0 para siempre, sin ningún error visible.
    const uid = toObjectId(profileId, 'profile id');

    // Ids bloqueados (en cualquier sentido): sus conversaciones 1-a-1 NO
    // aparecen en la lista de chats, asi que tampoco deben contar para el badge.
    // Esta era una causa del "badge fantasma": numero rojo sin ninguna
    // conversacion no-leida visible.
    const blockedIds = new Set(await getBlockedIdsFor(profileId));

    // Conversaciones donde participa el usuario, que NO oculto (hiddenBy).
    const conversations = await Conversation.find({
        participants: uid,
        hiddenBy: { $ne: uid },
        // PARKEADO (objects apagado): mismo criterio que la lista de chats. Sin
        // esto el badge cuenta mensajes de chats de objetos que ya no se pueden
        // abrir -> reaparece el "badge fantasma" descrito arriba.
        type: { $ne: ENUM_CONVERSATION_TYPE.projectGroup },
    })
        .select('_id type participants')
        .lean();

    // Excluir las 1-a-1 con usuarios bloqueados (mismo criterio que la lista de
    // chats), para que badge y lista siempre coincidan.
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

    // El badge cuenta CUANTOS chats/grupos tienen mensajes nuevos (no la suma de
    // mensajes). Asi el numero rojo coincide 1-a-1 con las conversaciones en
    // negrita de la lista.
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
// make changes-----------------------------------

const MessageService = {
    getMessages,
    deleteMessage,
    getUnreadMessageCount,
};

export default MessageService;
