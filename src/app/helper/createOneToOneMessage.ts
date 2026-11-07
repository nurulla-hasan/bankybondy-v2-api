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
    // Sin `io` se guarda el mensaje igual y no se emite nada: una llamada REST no
    // puede fallar porque la capa de sockets no esté levantada en ese proceso.
    io?: IOServer | null;
    // Veredicto ya obtenido. La rama del socket modera ANTES de ramificar (cubre
    // las cuatro ramas), así que reusa acá el mismo veredicto en vez de llamar otra
    // vez. REST no trae veredicto y entonces este núcleo modera por su cuenta.
    moderation?: SafetyResult;
};

export type OneToOneResult = {
    // Con `error` NO se guardó nada: el llamador lo muestra tal cual (socket
    // `emitError`, REST `AppError`). Sin `error`, el mensaje ya está guardado.
    error?: ErrorPayload;
    message?: any;
    conversation?: any;
};

// Mensaje 1-a-1: ESQUELETO COMÚN de los dos transportes (socket `send-message` y
// `POST /message/send`). Valida el receptor, respeta el bloqueo, crea la
// conversación si no existe, filtra los adjuntos, guarda, des-oculta el chat para
// los dos y emite. Cualquier regla nueva del 1-a-1 va acá, no en el llamador, para
// que REST no pueda saltársela.
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

    // Receptor VÁLIDO, DISTINTO de mí y EXISTENTE. Sin esto hay dos problemas
    // serios:
    //  1) Si `receiver` es mi propio id, la búsqueda de abajo (participants:yo AND
    //     participants:yo) matcheaba CUALQUIER conversación 1-a-1 mía: el mensaje
    //     podía terminar en una charla con otra persona pero emitirse a mi propio
    //     canal → historial corrupto y mensajes fantasma.
    //  2) Un ObjectId válido pero inexistente creaba una conversación huérfana
    //     (con un "usuario" que no existe).
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

    // Bloqueo: si emisor y receptor estan bloqueados entre si (en cualquier
    // sentido), NO se crea ni emite el mensaje. Solo aplica a la rama 1-a-1;
    // grupos y bondLink se validan aparte en handleChat.
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

    // La conversación 1-a-1 se identifica por sus DOS participantes EXACTOS
    // ($all + tamaño 2). Con dos condiciones `participants:X` sueltas, un id
    // repetido (self-message) matcheaba cualquier chat mío; el guard de arriba ya
    // lo evita y esto lo blinda de raíz.
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
        // Adjuntos: SOLO URLs de nuestro CDN (el cliente manda la URL; sin este
        // filtro podía inyectar cualquier link).
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

    // B1: la forma que se entrega al cliente (socket Y respuesta REST) es la del
    // helper común, no el documento crudo. Ver helper/messageEmitShape.ts para qué
    // se agrega, qué se saca y por qué `isMyMessage`/`seen` NO van acá.
    const clientMessage = shapeSentMessage(populatedMessage);

    // DES-OCULTAR a los dos. El listado de chats excluye toda conversación con tu
    // id en `hiddenBy`, y hasta acá enviar o recibir un mensaje NO sacaba a nadie
    // de ahí: una vez oculta, la charla quedaba invisible PARA SIEMPRE — le
    // escribías y el mensaje se guardaba y le llegaba, pero no aparecía en tu panel
    // ni buscándola por nombre. Y al revés era peor: si el otro había ocultado su
    // chat con vos, te escribía y no te enterabas nunca.
    //
    // Criterio (decidido con Emilio): OCULTAR es ordenar la lista, no silenciar.
    // Para "no me contactes" ya existe el BLOQUEO, función aparte que este mismo
    // código respeta más arriba.
    //
    // A propósito SOLO en el 1-a-1. En el chat de un vínculo el `hiddenBy` es
    // DELIBERADO: al rechazar un trueque el sistema te saca del chat
    // (modules/bondLink/bondLink.service.ts). Des-ocultar ahí te volvería a meter
    // en una conversación de la que saliste. Las ramas de grupo y bondLink NO se
    // tocan.
    //
    // Los ids se convierten a ObjectId explícitamente.
    //
    // CORRECCIÓN (27/8, panel adversarial). El comentario original decía que "un
    // `$pull` que no castea no falla: no saca nada y no avisa". Es FALSO acá, y los
    // dos revisores lo midieron por separado: sobre un path tipado `[ObjectId]`,
    // mongoose SÍ castea los strings, y cuando NO puede castear tira `CastError` —
    // falla RUIDOSO, no callado. La frase vale sólo para el driver crudo SIN
    // schema, que es el caso de una consulta de diagnóstico que me había fallado el
    // día anterior: la generalicé mal.
    //
    // Ninguna de las dos vías es "la segura", y conviene ser exacto porque una
    // versión anterior de este comentario también se pasó de la raya. Medido con el
    // mongoose de este repo, sobre `$pull:{hiddenBy:{$in:[v]}}`:
    //   - string hex válido → ObjectId por las dos vías. Igual.
    //   - string basura     → tiran las dos (BSONError vs CastError). Igual.
    //   - undefined / null  → SILENCIOSAS LAS DOS: el cast explícito devuelve un id
    //     AL AZAR (documentado en utilities/objectId.ts) y la vía cruda castea a
    //     `null` sin tirar. Para un `$pull` las dos son inertes.
    // O sea: el cast explícito no arregla ni empeora nada acá. Queda como
    // redundancia defensiva ante un cambio futuro de mongoose, NO como lo que hace
    // funcionar el fix. Lo que de verdad protege son las validaciones de aguas
    // arriba: `receiverId` pasa por `isValid` unas líneas más arriba y
    // `currentUserId` por `esObjectIdUsable` en socket.ts y en middlewares/auth.ts.
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

    // send to the frontend only new message data ---------------
    // Los ids ya validados van como cadena: el nombre del evento y la sala son los
    // que el cliente escucha, y un valor sin validar del cliente no los decide.
    if (io) {
        io.to(currentUserId.toString()).emit(
            `message-${receiverId}`,
            clientMessage
        );
        io.to(receiverId).emit(`message-${currentUserId}`, clientMessage);

        //send conversation
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

        // Aviso de mensajes no leidos al receptor.
        await emitUnreadCount(io, receiverId);
    }

    return { message: clientMessage, conversation };
};
