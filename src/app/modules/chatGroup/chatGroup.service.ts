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
    // Validate BEFORE persisting: creating the ChatGroup first left an orphan
    // group (no Conversation) when the participant check failed.
    if (!payload.participants || payload.participants?.length < 2) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'At least 2 member need to create a group'
        );
    }
    // REAL participants: deduplicated and without the creator (stored separately in
    // `creator`). If the client sent the creator inside `participants`, it ended up
    // DUPLICATED in the Conversation and counted as both member and creator.
    const creatorId = profileId.toString();
    const uniqueParticipants = [
        ...new Set(payload.participants.map((p) => p.toString())),
    ].filter((p) => p !== creatorId);
    // Only reject the DEGENERATE case: no real participant besides the creator.
    // (The guard above already requires 2 in the raw payload.)
    if (uniqueParticipants.length < 1) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'At least 1 participant other than the creator is required'
        );
    }
    // Blocking is checked across ALL group pairs, not just creator-vs-each. The
    // old creator-only check let two blocked users (B and C) share a group.
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

    // Participants must EXIST: valid-but-nonexistent ObjectIds created ghost users.
    // `addMember` already validated this; creation did not.
    const existentes = await NormalUser.countDocuments({
        _id: { $in: uniqueParticipants },
    });
    if (existentes !== uniqueParticipants.length) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Alguno de los participantes no existe'
        );
    }

    // Allowlist (anti mass-assignment): `creator` is forced to the caller.
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

    // Mass-assignment: only name and image are editable here. The raw body let the
    // creator inject `creator` or rewrite `participants`; membership goes through
    // add-member/remove-member.
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

    // Compare ObjectIds by VALUE: `array.includes(new ObjectId(x))` compares object
    // identity (always false). Authorized = creator or a group participant.
    const isGroupMember =
        group.creator.toString() === profileId ||
        group.participants.some((p) => p.equals(profileId));
    if (!isGroupMember) {
        throw new AppError(
            httpStatus.UNAUTHORIZED,
            'You are not able to add member , because you are not member of that group'
        );
    }
    // The creator counts as a member even though it is NOT in `participants`;
    // without this a participant could "add" the creator and duplicate it.
    if (
        group.creator.equals(memberId) ||
        group.participants.some((p) => p.equals(memberId))
    ) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Member is already part of that group'
        );
    }

    // Blocking applies between ALL members: a block with ANY current member blocks
    // entry, otherwise two blocked users would share the same chat.
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

    // Atomic and idempotent: `$addToSet` instead of push+save (which rewrote the
    // whole array, so concurrent addMember calls lost one member).
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

    // The creator cannot remove itself. In OLD groups (pre-dedup) the creator is
    // still inside `participants`, so the `$pull` below also removed it from
    // Conversation and locked it out of its own group while keeping creator rights.
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

// Same three keys as the chat-list members `$map` (conversation.service.ts).
// Nothing more: `email` is not exposed there either.
const ROSTER_SELECT = 'name profile_image _id';

// IDs of EVERYONE in the group: the creator is NOT in ChatGroup `participants`
// (it lives only in `creator`) but is in the conversation. Kept separate because
// that rule decides whether a creator can read its own roster.
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
 * COMPLETE member list of a group.
 * Previously the roster only existed inside `get-chat-list`, paginated by that
 * page's `limit`, so the UI could silently truncate it. No pagination; members only.
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

    // Non-member → 404, not 403: a 403 would confirm the group EXISTS.
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
        // Same shape as `members` in the chat list, built here instead of relying
        // on what the populate `select` lets through.
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
