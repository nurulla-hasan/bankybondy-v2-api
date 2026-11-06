/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * Marcar como leídos los mensajes ajenos de UNA conversación.
 *
 * Vive acá (y no dentro del socket) porque lo necesitan los DOS transportes: el
 * evento `seen` del socket y `POST /message/mark-seen`. Antes solo existía por
 * socket, así que un cliente sin conexión viva —o un reintento después de un
 * corte— no tenía ninguna forma de bajar el badge. Un solo código para los dos
 * caminos: copiadas, las guardas terminan separándose con el tiempo.
 *
 * Los emits en vivo van SOLO cuando llega `io`: por REST el resultado ya viaja
 * en la respuesta, y un proceso sin capa de sockets no debe romper el marcado.
 */
import { Server as IOServer } from 'socket.io';
import Conversation from '../modules/conversation/conversation.model';
import Message from '../modules/message/message.model';
import { esObjectIdUsable } from '../utilities/objectId';
import { emitUnreadCount } from './emitUnreadCount';
import { getSingleConversation } from './getSingleConversation';

export type MarkSeenResult = 'invalid' | 'not_found' | 'seen';

export type MarkSeenInput = {
    conversationId: unknown;
    currentUserId: string;
    io?: IOServer | null;
};

type MarkSeenDeps = {
    findConversation: (id: unknown) => PromiseLike<any>;
    markMessagesSeen: (conversationId: unknown, currentUserId: string) => PromiseLike<any>;
};

// La consulta de marcado, separada para poder probar su FORMA sin base de datos:
// `$addToSet` repite el read sin duplicar el id, y `msgByUserId: {$ne: yo}` deja
// afuera mis propios mensajes. Un `$set` o un `$ne` mal puesto se ve inocente
// hasta que el contador de no-leídos empieza a mentir.
export const seenQueryFor = (
    conversationId: unknown,
    currentUserId: string
): { filter: Record<string, unknown>; update: Record<string, unknown> } => ({
    filter: { conversationId, msgByUserId: { $ne: currentUserId } },
    update: { $addToSet: { seenBy: currentUserId } },
});

const realDeps: MarkSeenDeps = {
    findConversation: (id) => Conversation.findById(id).select('participants'),
    markMessagesSeen: (conversationId, currentUserId) => {
        const { filter, update } = seenQueryFor(conversationId, currentUserId);
        return Message.updateMany(filter, update);
    },
};

export const markSeen = async (
    { conversationId, currentUserId, io }: MarkSeenInput,
    deps: MarkSeenDeps = realDeps
): Promise<MarkSeenResult> => {
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
    if (!esObjectIdUsable(conversationId)) return 'invalid';

    // Seguridad (IDOR): solo un participante puede marcar la conversacion como
    // leida. Sin este chequeo, cualquiera con el id podria agregarse al seenBy
    // de mensajes de una conversacion ajena.
    const conversation = await deps.findConversation(conversationId);
    if (!conversation) return 'not_found';

    const participants: string[] = (conversation.participants ?? []).map(
        (p: any) => p?.toString()
    );
    if (!participants.includes(currentUserId.toString())) return 'not_found';

    // Marcar como vistos (seenBy) todos los mensajes de esta conversacion
    // que NO fueron enviados por el usuario que abre la conversacion.
    // Unificado sobre `seenBy` (no existe el campo `seen` en el schema).
    // Defensa en profundidad: se usa `conversation._id` (el id REAL del
    // documento que ya se validó como propio), no el valor que mandó el
    // cliente. Aunque la guarda de arriba ya corta los operadores, así el
    // `updateMany` siempre corre sobre UNA sola conversación verificada.
    await deps.markMessagesSeen(conversation._id, currentUserId);

    if (!io) return 'seen';

    // Refrescar el contador de no-leidos del LECTOR (fuente unica): baja el
    // badge + quita la negrita al leer, del lado servidor (multi-dispositivo).
    await emitUnreadCount(io, currentUserId.toString());

    // Derivar el OTRO participante desde la conversacion (ya la tenemos arriba).
    const otherId = participants.find((id) => id !== currentUserId.toString());

    const conversationSender = await getSingleConversation(
        conversation._id.toString(),
        currentUserId.toString(),
        'participants'
    );
    if (conversationSender) {
        io.to(currentUserId.toString()).emit('conversation', conversationSender);
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

    return 'seen';
};
