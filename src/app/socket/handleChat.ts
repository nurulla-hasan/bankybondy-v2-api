/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from 'mongoose';
import NormalUser from '../modules/normalUser/normalUser.model';
import { Server as IOServer, Socket } from 'socket.io';
import { getSingleConversation } from '../helper/getSingleConversation';
import { BondLink } from '../modules/bondLink/bondLink.model';
import ChatGroup from '../modules/chatGroup/chatGroup.model';
import { ENUM_CONVERSATION_TYPE } from '../modules/conversation/conversation.enum';
import Conversation from '../modules/conversation/conversation.model';
import Message from '../modules/message/message.model';
import MessageService from '../modules/message/message.service';
// PARKED (proyectos apagados): solo lo usaba la rama `projectId` del socket, ahora
// neutralizada. Reactivar objetos = descomentar esto y el cuerpo de esa rama.
// import Project from '../modules/project/project.model';
import { getBlockedIdsFor } from '../modules/userBlock/userBlock.service';
import { isMessageSafe } from '../helper/isTextSafe';
import { filterCdnAttachmentUrls } from '../helper/attachmentUrl';
import { esObjectIdUsable } from '../utilities/objectId';
import { emitError } from './helper';

// Emite al receptor su conteo de mensajes no leidos (B.5). Best-effort: no debe
// romper el flujo de envio de mensajes si algo falla.
const emitUnreadCount = async (io: IOServer, receiverId: string) => {
    try {
        const { totalUnread, perConversation } =
            await MessageService.getUnreadMessageCount(receiverId);
        io.to(receiverId.toString()).emit('message-notification', {
            totalUnread,
            perConversation,
        });
    } catch {
        // Silencioso a proposito: la notificacion es secundaria al mensaje.
    }
};

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
            !data.projectId &&
            !data.groupId &&
            !data.bondLinkId
        ) {
            emitError(socket, {
                code: 400,
                message: 'Receiver or project id required',
                type: 'general',
                details:
                    'You must provide either a receiverId (for one-to-one) or a projectId (for group chat) or a groupId (for chat group) or a bondLinkId (for bond link chat)',
            });
            return;
        }

        // Moderacion de mensajes (censura gratis): lista dura + capa gratis de
        // OpenAI (omni-moderation-latest). Bloquea al enviar; si OpenAI falla,
        // fail-open (no rompe el chat). Cubre las 4 ramas porque va antes de
        // ramificar por receiver/projectId/groupId/bondLinkId.
        const msgText = (data?.text || '').toString();
        if (msgText.trim()) {
            const verdict = await isMessageSafe(msgText);
            if (!verdict.safe) {
                emitError(socket, {
                    code: 422,
                    message:
                        verdict.reason ||
                        'Este mensaje no cumple las normas de la plataforma.',
                    type: 'general',
                    // Objeto (no string) para que el front ubique y borre la
                    // burbuja optimista EXACTA por su clientId (o por texto si el
                    // front es viejo y no lo mandó), sin refrescar.
                    details: {
                        kind: 'message_blocked',
                        text: msgText,
                        clientId: data?.clientId,
                    },
                });
                return;
            }
        }

        if (data?.receiver) {
            const receiverId = data.receiver.toString();

            // Receptor VÁLIDO, DISTINTO de mí y EXISTENTE. Sin esto había dos
            // problemas serios:
            //  1) Si `receiver` era mi propio id, la búsqueda de abajo
            //     (participants:yo AND participants:yo) matcheaba CUALQUIER
            //     conversación 1-a-1 mía: el mensaje podía terminar en una charla
            //     con otra persona pero emitirse a mi propio canal → historial
            //     corrupto y mensajes fantasma.
            //  2) Un ObjectId válido pero inexistente creaba una conversación
            //     huérfana (con un "usuario" que no existe).
            if (
                !Types.ObjectId.isValid(receiverId) ||
                receiverId === currentUserId.toString()
            ) {
                emitError(socket, {
                    code: 400,
                    message: 'Invalid receiver',
                    type: 'general',
                    details: 'You must provide a valid, different receiver',
                });
                return;
            }
            const receiverExists = await NormalUser.exists({ _id: receiverId });
            if (!receiverExists) {
                emitError(socket, {
                    code: 404,
                    message: 'Receiver not found',
                    type: 'general',
                    details: 'The receiver user does not exist',
                });
                return;
            }

            // Bloqueo (B.4): si emisor y receptor estan bloqueados entre si (en
            // cualquier sentido), NO se crea ni emite el mensaje. Solo aplica a
            // la rama 1-a-1; grupos/proyectos/bondLink no se ven afectados.
            const blockedIds = await getBlockedIdsFor(currentUserId);
            if (blockedIds.includes(receiverId)) {
                emitError(socket, {
                    code: 403,
                    message: 'You cannot message this user',
                    type: 'general',
                    details:
                        'Messaging is not allowed between blocked users',
                });
                return;
            }

            // La conversación 1-a-1 se identifica por sus DOS participantes EXACTOS
            // ($all + tamaño 2). Antes con dos condiciones `participants:X` sueltas
            // un id repetido (self-message) matcheaba cualquier chat mío; el guard
            // de arriba ya lo evita, y esto lo blinda de raíz.
            let conversation = await Conversation.findOne({
                participants: { $all: [currentUserId, data.receiver], $size: 2 },
                type: ENUM_CONVERSATION_TYPE.oneToOne,
            });
            if (!conversation) {
                conversation = await Conversation.create({
                    participants: [currentUserId, data.receiver],
                    type: ENUM_CONVERSATION_TYPE.oneToOne,
                });
            }

            const messageData = {
                text: data.text || '',
                // Adjuntos: SOLO URLs de nuestro CDN (el cliente manda la URL por
                // el socket; sin este filtro podía inyectar cualquier link).
                imageUrl: filterCdnAttachmentUrls(data.imageUrl),
                videoUrl: filterCdnAttachmentUrls(data.videoUrl),
                pdfUrl: filterCdnAttachmentUrls(data.pdfUrl),
                msgByUserId: currentUserId,
                conversationId: conversation?._id,
            };
            const saveMessage = await Message.create(messageData);
            const populatedMessage = await saveMessage.populate({
                path: 'msgByUserId',
                select: 'name profile_image',
            });
            // DES-OCULTAR a los dos (A16). El listado de chats excluye toda
            // conversación con tu id en `hiddenBy` (conversation.service:73), y
            // hasta acá enviar o recibir un mensaje NO sacaba a nadie de ahí. Una
            // vez oculta, la charla quedaba invisible PARA SIEMPRE: le escribías y
            // el mensaje se guardaba y le llegaba, pero no aparecía en tu panel ni
            // buscándola por nombre. Y al revés era peor: si el otro había ocultado
            // su chat con vos, te escribía y no te enterabas nunca — el mensaje
            // entraba a la base y desaparecía de su vista. Confirmado contra la
            // base viva el 26/8 (5 chats 1-a-1 ocultos en la cuenta de Emilio).
            //
            // Criterio (decidido con Emilio): OCULTAR es ordenar la lista, no
            // silenciar. Para "no me contactes" ya existe el BLOQUEO, que es una
            // función aparte y que este mismo handler ya respeta más arriba.
            //
            // SOLO en la rama 1-a-1, a propósito. En el chat de un vínculo el
            // `hiddenBy` es DELIBERADO: al rechazar un trueque el sistema te saca
            // del chat (bondLink.service:670). Des-ocultar ahí te volvería a meter
            // en una conversación de la que saliste. Las ramas de grupo y bondLink
            // NO se tocan.
            //
            // Los ids se convierten a ObjectId explícitamente.
            //
            // CORRECCIÓN (27/8, panel adversarial). El comentario original decía
            // que "un `$pull` que no castea no falla: no saca nada y no avisa".
            // Es FALSO acá, y los dos revisores lo midieron por separado: sobre un
            // path tipado `[ObjectId]`, mongoose SÍ castea los strings, y cuando NO
            // puede castear tira `CastError` — falla RUIDOSO, no callado. La frase
            // vale sólo para el driver crudo SIN schema, que es el caso de una
            // consulta de diagnóstico que me había fallado el día anterior: la
            // generalicé mal.
            //
            // Ninguna de las dos vías es "la segura", y conviene ser exacto porque
            // una versión anterior de este comentario también se pasó de la raya.
            // Medido con el mongoose de este repo, sobre `$pull:{hiddenBy:{$in:[v]}}`:
            //   - string hex válido → ObjectId por las dos vías. Igual.
            //   - string basura     → tiran las dos (BSONError vs CastError). Igual.
            //   - undefined / null  → SILENCIOSAS LAS DOS: el cast explícito devuelve
            //     un id AL AZAR (documentado en utilities/objectId.ts) y la vía cruda
            //     castea a `null` sin tirar. Para un `$pull` las dos son inertes.
            // O sea: el cast explícito no arregla ni empeora nada acá. Queda como
            // redundancia defensiva ante un cambio futuro de mongoose, NO como lo que
            // hace funcionar el fix. Lo que de verdad protege son las validaciones de
            // aguas arriba: `receiverId` pasa por `isValid` unas líneas más arriba y
            // `currentUserId` por `esObjectIdUsable` en socket.ts.
            await Conversation.updateOne(
                { _id: conversation?._id },
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
            io.to(currentUserId.toString()).emit(
                `message-${data?.receiver}`,
                populatedMessage
            );
            io.to(data?.receiver.toString()).emit(
                `message-${currentUserId}`,
                populatedMessage
            );

            //send conversation
            const conversationSender = await getSingleConversation(
                conversation._id.toString(),
                currentUserId,
                'participants'
            );
            const conversationReceiver = await getSingleConversation(
                conversation._id.toString(),
                data?.receiver,
                'participants'
            );
            io.to(currentUserId.toString()).emit(
                'conversation',
                conversationSender
            );
            io.to(data?.receiver).emit('conversation', conversationReceiver);

            // Aviso de mensajes no leidos al receptor (B.5).
            await emitUnreadCount(io, data?.receiver);
        } else if (data?.projectId) {
            // Proyectos/objetos APAGADOS (invariante del proyecto: nada de eso debe
            // funcionar de ninguna manera por ahora). Aunque las rutas /project
            // están desmontadas, esta rama del socket seguía aceptando `projectId`
            // y creaba/emitía mensajes en conversaciones de proyecto. Se rechaza.
            // Reactivar objetos = quitar este guard ("solo cablear").
            emitError(socket, {
                code: 403,
                message: 'Feature not available',
                type: 'general',
                details: 'Project chat is disabled',
            });
            return;
            /* PARKED (proyectos apagados): cuerpo original PRESERVADO para
               reactivar cuando se enciendan objetos ("solo cablear" = borrar el
               guard de arriba y este comentario). No se ejecuta.
            const projectId = data?.projectId;
            if (projectId && Types.ObjectId.isValid(projectId)) {
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

            const [project, chat] = await Promise.all([
                Project.findById(data?.projectId)
                    .select('_id')
                    .lean(),
                Conversation.findOne({ project: projectId })
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
            if (!project) {
                emitError(socket, {
                    code: 400,
                    message: 'Project not found',
                    type: 'general',
                    details: 'Project not found',
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

            // create new message
            const messageData = {
                text: data.text,
                // Adjuntos: SOLO URLs de nuestro CDN (el cliente manda la URL por
                // el socket; sin este filtro podía inyectar cualquier link).
                imageUrl: filterCdnAttachmentUrls(data.imageUrl),
                videoUrl: filterCdnAttachmentUrls(data.videoUrl),
                pdfUrl: filterCdnAttachmentUrls(data.pdfUrl),
                msgByUserId: currentUserId,
                conversationId: chat?._id,
            };
            const saveMessage = await Message.create(messageData);
            const populatedMessage = await saveMessage.populate({
                path: 'msgByUserId',
                select: 'name profile_image',
            });
            await Conversation.updateOne(
                { _id: chat?._id },
                {
                    lastMessage: populatedMessage._id,
                }
            );

            // chat.participants.forEach(async (participantId: Types.ObjectId) => {
            //     io.to(participantId.toString()).emit(
            //         `message-${projectId}`,
            //         populatedMessage
            //     );
            //     const singleConversation = await getSingleConversation(
            //         chat._id,
            //         participantId.toString()
            //     );
            //     io.to(participantId.toString()).emit(
            //         'conversation',
            //         singleConversation
            //     );
            // });

            await Promise.all(
                chat.participants.map(async (participantId: Types.ObjectId) => {
                    const uid = participantId.toString();
                    io.to(uid).emit(`message-${projectId}`, populatedMessage);

                    const singleConversation = await getSingleConversation(
                        chat._id.toString(),
                        uid,
                        'project'
                    );
                    io.to(uid).emit('conversation', singleConversation);

                    // Refrescar el contador de no-leidos del participante (fuente
                    // unica): sube badge + negrita en vivo tambien en grupos.
                    if (uid !== currentUserId.toString()) {
                        await emitUnreadCount(io, uid);
                    }
                })
            );
            */
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
                text: data.text,
                // Adjuntos: SOLO URLs de nuestro CDN (el cliente manda la URL por
                // el socket; sin este filtro podía inyectar cualquier link).
                imageUrl: filterCdnAttachmentUrls(data.imageUrl),
                videoUrl: filterCdnAttachmentUrls(data.videoUrl),
                pdfUrl: filterCdnAttachmentUrls(data.pdfUrl),
                msgByUserId: currentUserId,
                conversationId: chat?._id,
            };
            const saveMessage = await Message.create(messageData);
            const populatedMessage = await saveMessage.populate({
                path: 'msgByUserId',
                select: 'name profile_image',
            });
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
                    io.to(uid).emit(`message-${groupId}`, populatedMessage);
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
                text: data.text,
                // Adjuntos: SOLO URLs de nuestro CDN (el cliente manda la URL por
                // el socket; sin este filtro podía inyectar cualquier link).
                imageUrl: filterCdnAttachmentUrls(data.imageUrl),
                videoUrl: filterCdnAttachmentUrls(data.videoUrl),
                pdfUrl: filterCdnAttachmentUrls(data.pdfUrl),
                msgByUserId: currentUserId,
                conversationId: chat?._id,
            };
            const saveMessage = await Message.create(messageData);
            const populatedMessage = await saveMessage.populate({
                path: 'msgByUserId',
                select: 'name profile_image',
            });
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
                    io.to(uid).emit(`message-${bondLinkId}`, populatedMessage);
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
        // El front ahora emite `seen` con payload SOLO { conversationId }.
        // INYECCIÓN NoSQL: el `if (!conversationId)` NO alcanza, porque un OBJETO
        // es truthy. `sanitizeMongo` es middleware de EXPRESS, así que los payloads
        // de socket.io NO pasan por él: lo que manda el cliente llega crudo.
        // Verificado: mongoose CONSERVA el operador tanto en `findById` como en el
        // `updateMany` de más abajo. Con `conversationId = {"$gte": "<id>"}`, el
        // `findById` devuelve el primer documento en orden natural —y los ObjectId
        // son cronológicos, así que con unos pocos intentos cae en una conversación
        // propia y el chequeo de participante pasa— y después el `updateMany` corre
        // con el operador INTACTO sobre los mensajes de TODAS las conversaciones
        // posteriores a ese límite: le mete su profileId en el `seenBy` de mensajes
        // ajenos y rompe el contador de no leídos de toda la plataforma.
        // Las otras ramas de este archivo se salvan porque validan con `isValid`.
        if (!esObjectIdUsable(conversationId)) return;

        // Seguridad (IDOR): solo un participante puede marcar la conversacion como
        // leida. Sin este chequeo, cualquiera con el id podria agregarse al seenBy
        // de mensajes de una conversacion ajena.
        const conversation = await Conversation.findById(conversationId).select(
            'participants'
        );
        if (
            !conversation ||
            !isParticipant(conversation.participants, currentUserId.toString())
        ) {
            return;
        }

        // Marcar como vistos (seenBy) todos los mensajes de esta conversacion
        // que NO fueron enviados por el usuario que abre la conversacion.
        // Unificado sobre `seenBy` (no existe el campo `seen` en el schema).
        // Defensa en profundidad: se usa `conversation._id` (el id REAL del
        // documento que ya se validó como propio), no el valor que mandó el
        // cliente. Aunque la guarda de arriba ya corta los operadores, así el
        // `updateMany` opera por construcción sobre UNA conversación verificada.
        await Message.updateMany(
            {
                conversationId: conversation._id,
                msgByUserId: { $ne: currentUserId },
            },
            { $addToSet: { seenBy: currentUserId } }
        );

        // Refrescar el contador de no-leidos del LECTOR (fuente unica): baja el
        // badge + quita la negrita al leer, del lado servidor (multi-dispositivo).
        await emitUnreadCount(io, currentUserId.toString());

        // Derivar el OTRO participante desde la conversacion (ya la tenemos arriba).
        const otherId = conversation?.participants
            ?.map((p: any) => p.toString())
            .find((id: string) => id !== currentUserId.toString());

        //send conversation --------------
        const conversationSender = await getSingleConversation(
            conversation._id.toString(),
            currentUserId as string,
            'participants'
        );
        if (conversationSender) {
            io.to(currentUserId.toString()).emit(
                'conversation',
                conversationSender
            );
        }

        if (otherId) {
            const conversationReceiver = await getSingleConversation(
                conversation._id.toString(),
                otherId,
                'participants'
            );
            if (conversationReceiver) {
                io.to(otherId).emit('conversation', conversationReceiver);
            }
        }
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
