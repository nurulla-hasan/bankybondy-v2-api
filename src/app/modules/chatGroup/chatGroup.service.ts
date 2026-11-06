import httpStatus from 'http-status';
import mongoose from 'mongoose';
import AppError from '../../error/appError';
import { ENUM_CONVERSATION_TYPE } from '../conversation/conversation.enum';
import Conversation from '../conversation/conversation.model';
import NormalUser from '../normalUser/normalUser.model';
import { findBlockedPairAmong } from '../userBlock/userBlock.service';
import { esObjectIdUsable } from '../../utilities/objectId';
import { IChatGroup } from './chatGroup.interface';
import ChatGroup from './chatGroup.model';

const createGroupChat = async (
    profileId: string,
    payload: Partial<IChatGroup>
) => {
    // Validar ANTES de persistir: antes se creaba el ChatGroup y recién después se
    // chequeaba la cantidad de participantes → si fallaba, quedaba un grupo huérfano
    // (sin su Conversation) en la base.
    if (!payload.participants || payload.participants?.length < 2) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'At least 2 member need to create a group'
        );
    }
    // Participantes REALES: sin repetidos y sin el creador (que ya se guarda aparte
    // en `creator` y se agrega explícito a la conversación). Si el cliente mandaba al
    // creador dentro de `participants`, quedaba DUPLICADO en la Conversation
    // (`[...payload.participants, profileId]`) y figuraba a la vez como participante
    // y como creador.
    const creatorId = profileId.toString();
    const uniqueParticipants = [
        ...new Set(payload.participants.map((p) => p.toString())),
    ].filter((p) => p !== creatorId);
    // Sólo se corta el caso DEGENERADO: ningún participante real además del creador.
    // (ChatGPT exigía >= 2 acá, pero eso rechazaría un grupo legítimo de "yo + 1" si
    // el cliente incluye al creador en el payload —la app nativa no está en el repo
    // para descartarlo—. El guard de arriba ya exige 2 en el payload crudo.)
    if (uniqueParticipants.length < 1) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'At least 1 participant other than the creator is required'
        );
    }
    // Deduplicar participantes e incluir al creador: el bloqueo se valida entre
    // TODOS los pares del grupo, no sólo creador-vs-cada-uno. Antes se miraba
    // únicamente al creador: si A armaba un grupo con B y C, y B tenía bloqueado a
    // C, el bloqueo se ignoraba y los dos terminaban en el mismo chat grupal
    // (mismo bug que bondLink ya cerró con findBlockedPairAmong).
    const todos = Array.from(new Set([creatorId, ...uniqueParticipants]));
    const parBloqueado = await findBlockedPairAmong(todos);
    if (parBloqueado) {
        const involucraAlCreador =
            parBloqueado.blocker === creatorId ||
            parBloqueado.blocked === creatorId;
        throw new AppError(
            httpStatus.BAD_REQUEST,
            involucraAlCreador
                ? 'No podés crear un grupo con un usuario bloqueado'
                : 'No se puede crear el grupo: hay un bloqueo entre dos de los participantes.'
        );
    }

    // Todos los participantes deben EXISTIR. Sin esto se podía crear un grupo con
    // ObjectIds válidos pero inexistentes (conversación con "usuarios" fantasma).
    // `addMember` ya validaba esto; la creación no.
    const existentes = await NormalUser.countDocuments({
        _id: { $in: uniqueParticipants },
    });
    if (existentes !== uniqueParticipants.length) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Alguno de los participantes no existe'
        );
    }

    // Allowlist (anti mass-assignment): `creator` se fuerza al que crea el grupo.
    const result = await ChatGroup.create({
        name: payload.name,
        participants: uniqueParticipants,
        image: payload.image,
        creator: creatorId,
    });
    await Conversation.create({
        chatGroup: result._id,
        type: ENUM_CONVERSATION_TYPE.chatGroup,
        participants: [...uniqueParticipants, creatorId],
    });
    return result;
};

const updateGroupData = async (
    profileId: string,
    id: string,
    payload: Partial<IChatGroup>
) => {
    const group = await ChatGroup.findById(id);
    if (!group) {
        throw new AppError(httpStatus.NOT_FOUND, 'Group not found');
    }

    if (group.creator.toString() != profileId) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'You are not authorized for update group'
        );
    }

    // Mass-assignment: solo nombre e imagen del grupo se editan por acá. Antes se
    // metía todo el body → el creador podía inyectar `creator` (regalar/orfanar el
    // grupo) o reescribir `participants` entero. Los miembros se gestionan por
    // add-member/remove-member, no por este update.
    const safePayload: Partial<IChatGroup> = {};
    for (const k of ['name', 'image'] as const) {
        if ((payload as any)[k] !== undefined) {
            (safePayload as any)[k] = (payload as any)[k];
        }
    }

    const result = await ChatGroup.findByIdAndUpdate(id, safePayload, {
        new: true,
        runValidators: true,
    });
    return result;
};

const addMember = async (
    profileId: string,
    groupId: string,
    memberId: string
) => {
    const [group, user] = await Promise.all([
        ChatGroup.findById(groupId),
        NormalUser.findById(memberId),
    ]);
    if (!group) {
        throw new AppError(httpStatus.NOT_FOUND, 'Group not found');
    }
    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    // Comparar ObjectId por VALOR: `array.includes(new ObjectId(x))` compara por
    // identidad de objeto (siempre false) → antes ni el dueño podía agregar y los
    // duplicados no se detectaban. `.some(p => p.equals(x))` compara el valor.
    // Autorizado = creador (que se guarda aparte, puede no estar en participants) o
    // un participante del grupo.
    const isGroupMember =
        group.creator.toString() === profileId ||
        group.participants.some((p) => p.equals(profileId));
    if (!isGroupMember) {
        throw new AppError(
            httpStatus.UNAUTHORIZED,
            'You are not able to add member , because you are not member of that group'
        );
    }
    // El creador cuenta como miembro aunque NO figure en `participants` (desde el
    // dedup de `createGroupChat` vive sólo en `creator`). Sin esta mitad, cualquier
    // participante podía "agregar" al creador y volver a duplicarlo en el array.
    if (
        group.creator.equals(memberId) ||
        group.participants.some((p) => p.equals(memberId))
    ) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Member is already part of that group'
        );
    }

    // El bloqueo alcanza a los grupos, y entre TODOS: no basta con que el que
    // agrega no tenga bloqueo con el nuevo. Si el nuevo tiene un bloqueo con
    // CUALQUIER miembro ya presente, tampoco puede entrar (si no, quedarían dos
    // usuarios bloqueados en el mismo chat). Se evalúa al nuevo contra el grupo
    // completo (creador + participantes actuales).
    const miembrosActuales = Array.from(
        new Set([
            group.creator.toString(),
            ...group.participants.map((p) => p.toString()),
        ])
    );
    const parBloqueado = await findBlockedPairAmong([
        ...miembrosActuales,
        memberId,
    ]);
    if (parBloqueado) {
        const involucraAlNuevo =
            parBloqueado.blocker === memberId ||
            parBloqueado.blocked === memberId;
        throw new AppError(
            httpStatus.BAD_REQUEST,
            involucraAlNuevo
                ? 'No podés agregar a un usuario bloqueado'
                : 'No se puede agregar: hay un bloqueo entre participantes del grupo.'
        );
    }

    // Atómico e idempotente: `$addToSet` en vez de push+save (que reescribía el
    // array entero → dos addMember concurrentes con miembros distintos perdían uno
    // y ChatGroup/Conversation divergían). Ahora ninguna escritura pisa a la otra.
    const updated = await ChatGroup.findByIdAndUpdate(
        groupId,
        { $addToSet: { participants: new mongoose.Types.ObjectId(memberId) } },
        { new: true }
    );

    await Conversation.updateOne(
        { chatGroup: groupId },
        { $addToSet: { participants: new mongoose.Types.ObjectId(memberId) } }
    );
    return updated;
};

const removeMember = async (
    profileId: string,
    groupId: string,
    memberId: string
) => {
    const group = await ChatGroup.findById(groupId);
    if (!group) {
        throw new AppError(httpStatus.NOT_FOUND, 'Invalid group id');
    }

    if (group.creator.toString() != profileId) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'You are not authorized for remove member'
        );
    }

    // El creador NO se puede remover a sí mismo. En los grupos VIEJOS (creados
    // antes del dedup) el creador todavía figura dentro de `participants`, así que
    // pasaba este chequeo y el `$pull` de abajo lo sacaba también de
    // `Conversation.participants` → quedaba fuera del chat de SU PROPIO grupo
    // (`getMessages` le devolvía 404 y el socket lo rechazaba), conservando igual
    // los permisos de creator. En los grupos nuevos ya era inalcanzable; esto cierra
    // los viejos.
    if (group.creator.equals(memberId)) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'The group creator cannot be removed'
        );
    }

    if (!group.participants.some((p) => p.equals(memberId))) {
        throw new AppError(
            httpStatus.NOT_FOUND,
            'This member not include in that group'
        );
    }

    const result = await ChatGroup.findByIdAndUpdate(
        groupId,
        { $pull: { participants: memberId } },
        { new: true, runValidators: true }
    );
    await Conversation.findOneAndUpdate(
        { chatGroup: groupId },
        { $pull: { participants: memberId } }
    );
    return result;
};

// Las mismas tres claves que la lista de chats para los integrantes
// (conversation.service.ts, el `$map` de `members`). Nada más: `email` tampoco
// viaja por la lista.
const ROSTER_SELECT = 'name profile_image _id';

// Los ids de TODOS los del grupo: el creador NO está en `participants` del
// ChatGroup (desde el dedup de createGroupChat vive solo en `creator`), pero sí
// en la conversación. Función aparte porque esa regla es la que hace que un
// creador pueda leer su propio roster o no.
export const groupMemberIds = (group: any): Set<string> =>
    new Set(
        [
            ...(group.participants ?? []).map((p: any) => p?._id ?? p),
            group.creator?._id ?? group.creator,
        ]
            .filter(Boolean)
            .map((id: any) => id.toString())
    );

/**
 * La lista COMPLETA de miembros de un grupo.
 *
 * Hasta ahora el roster solo vivía dentro de `get-chat-list`, con el `limit` de
 * esa página: con muchos miembros la UI podía mostrarlos cortados en silencio.
 * Esta lectura no pagina y está abierta solo para miembros.
 */
const getGroupMembers = async (profileId: string, groupId: string) => {
    if (!esObjectIdUsable(groupId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid group id');
    }

    const group: any = await ChatGroup.findById(groupId)
        .populate({ path: 'participants', select: ROSTER_SELECT })
        .populate({ path: 'creator', select: ROSTER_SELECT });

    if (!group) {
        throw new AppError(httpStatus.NOT_FOUND, 'Group not found');
    }

    // No-miembro → 404, no 403: un 403 confirmaría que el grupo EXISTE. Además
    // el grupo ya le es invisible en su lista de chats, así que 404 es coherente.
    if (!groupMemberIds(group).has(String(profileId))) {
        throw new AppError(httpStatus.NOT_FOUND, 'Group not found');
    }

    const rosterOf = (p: any) => ({
        _id: p?._id,
        name: p?.name,
        profile_image: p?.profile_image,
    });

    return {
        _id: group._id,
        name: group.name,
        image: group.image,
        creator: rosterOf(group.creator),
        // Mismo shape que `members` en la lista de chats, escrito acá en vez de
        // depender de lo que deje pasar el `select` del populate.
        participants: (group.participants ?? []).map(rosterOf),
    };
};

const ChatGroupServices = {
    createGroupChat,
    addMember,
    removeMember,
    updateGroupData,
    getGroupMembers,
};
export default ChatGroupServices;
