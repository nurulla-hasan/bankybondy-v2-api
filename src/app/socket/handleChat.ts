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

// ¿el usuario está entre los participantes del chat? (control anti-IDOR)
const isParticipant = (participants: any[], userId: string): boolean =>
    Array.isArray(participants) &&
    participants.some((p) => p?.toString() === userId?.toString());

// ¿el emisor tiene una relación de bloqueo (en cualquier sentido) con alguien de
// este chat grupal? Las ramas de grupo validaban SOLO membresía, así que un
// bloqueo hecho DESPUÉS de armar el grupo no tenía ningún efecto: los dos
// usuarios seguían cruzándose ahí adentro. Es el complemento del guard de
// creación en bondLink.service (que impide formar el grupo) para el caso del
// bloqueo posterior.
//
// Se compara al EMISOR contra el resto, no todos los pares: si dos terceros se
// bloquearon entre sí, eso no debe silenciar a alguien ajeno a ese conflicto.
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

// Payload de error único para el corte por bloqueo en grupos. No dice QUIÉN está
// bloqueado: en un grupo eso delataría una relación entre terceros.
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
    // new message -----------------------------------
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

        // Texto NORMALIZADO para las TRES ramas. Un valor no-string (null, un
        // número, un objeto) se guardaba igual, y el filtro fijo de `getMessages`
        // (`text: {$regex: ''}`) nunca lo matcheaba → el mensaje desaparecía del
        // historial para siempre, sin dar ningún error.
        const msgText = normalizeMessageText(data?.text);

        // Moderacion de mensajes (censura gratis): lista dura + capa gratis de
        // OpenAI (omni-moderation-latest). Bloquea al enviar; si OpenAI falla,
        // fail-open (no rompe el chat). Cubre las 3 ramas porque va antes de
        // ramificar por receiver/groupId/bondLinkId. El veredicto se
        // guarda: la rama 1-a-1 lo reusa en el núcleo y así no se paga dos veces.
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

        // Adjuntos: se reparten UNA vez, antes de ramificar, para poder avisar los
        // descartados y no guardar un mensaje sin contenido.
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
            // El MISMO núcleo que usa `POST /message/send`: valida el receptor y el
            // bloqueo, crea la conversación si falta, filtra los adjuntos, guarda,
            // des-oculta el chat para los dos y emite. Las reglas del 1-a-1 viven
            // en helper/createOneToOneMessage.ts, no acá, para que ningún
            // transporte pueda saltárselas.
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

            // Solo un participante del chat puede enviar mensajes (anti-IDOR).
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

            // create new message
            const messageData = {
                text: msgText,
                // Adjuntos: SOLO URLs de nuestro CDN (el cliente manda la URL por
                // el socket; sin este filtro podía inyectar cualquier link).
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
            // B1: se emite la forma común (helper/messageEmitShape.ts), no el doc
            // crudo — mismas claves que entrega `get-messages`.
            const clientMessage = shapeSentMessage(populatedMessage);
            // A16 (2a parte): mismo des-ocultar que en 1-a-1, ahora para el chat
            // de GRUPO. El fix original cerro solo la rama 1-a-1 y la clase quedo
            // abierta aca: el boton "Ocultar" se ofrece para CUALQUIER tipo de
            // conversacion sin mirar el tipo (ConversationListItem.jsx), el listado
            // excluye por hiddenBy sin importar el tipo (conversation.service.ts) y
            // el badge de no-leidos tambien (message.service.ts). O sea que un grupo
            // oculto se tragaba los mensajes exactamente igual, y la medicion del
            // 26/8 encontro 2 asi en produccion. El modal de confirmacion —que es el
            // MISMO para los tres tipos— promete "Podras seguir recibiendo mensajes
            // nuevos de este chat"; hasta aca esa promesa era mentira en grupos.
            //
            // Se des-oculta a TODOS los participantes, no solo al emisor: el
            // criterio es el mismo que en 1-a-1 (ocultar ordena la lista, no
            // silencia) y en un grupo el mensaje llega a todos.
            //
            // La rama de bondLink NO se toca: ahi hiddenBy tambien lo usa
            // rejectBondLink a proposito para sacar del chat al que rechaza.
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

                    // Refrescar el contador de no-leidos del participante (fuente
                    // unica): sube badge + negrita en vivo tambien en grupos.
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

            // Solo un participante del chat puede enviar mensajes (anti-IDOR).
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

            // "Salió del chat" (rechazó el trueque → quedó en hiddenBy): no puede
            // seguir mandando mensajes al grupo del que se fue. Los que se quedan sí
            // siguen chateando (el trueque cae, la conversación queda de historial).
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

            // create new message
            const messageData = {
                text: msgText,
                // Adjuntos: SOLO URLs de nuestro CDN (el cliente manda la URL por
                // el socket; sin este filtro podía inyectar cualquier link).
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
            // B1: se emite la forma común (helper/messageEmitShape.ts), no el doc
            // crudo — mismas claves que entrega `get-messages`.
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
                    // Los que salieron del chat (hiddenBy) no reciben el mensaje ni
                    // la re-inserción en vivo del chat que ocultaron.
                    if (hiddenBy.includes(uid)) return;
                    io.to(uid).emit(`message-${bondLinkId}`, clientMessage);
                    const singleConversation = await getSingleConversation(
                        chat._id.toString(),
                        uid,
                        'bondLink'
                    );
                    io.to(uid).emit('conversation', singleConversation);

                    // Refrescar el contador de no-leidos del participante (fuente
                    // unica): sube badge + negrita en vivo tambien en grupos.
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

    // send---------------------------------
    socket.on('seen', async ({ conversationId }) => {
      try {
        // Las guardas (NoSQL crudo, IDOR) viven en markSeen, que es el mismo
        // código que usa `POST /message/mark-seen`; duplicarlas acá es la forma
        // clásica de que un camino se arregle y el otro no. El resultado se
        // ignora a propósito: como antes, el socket no avisa de un id inválido
        // ni de un no-participante (no le entrega nada nuevo a nadie).
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
