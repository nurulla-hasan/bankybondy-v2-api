import { escapeRegex } from '../../utilities/escapeRegex';
/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import mongoose from 'mongoose';
import QueryBuilder from '../../builder/QueryBuilder';
import AppError from '../../error/appError';
import { deleteFileFromS3 } from '../../helper/deleteFromS3';
import { clampLimit, clampPage } from '../../utilities/pagination';
import { ENUM_AUDIO_MODERATION_STATUS } from '../audio/audio.interface';
import { IPlaylist } from './playlist.interface';
import Playlist from './playlist.model';
import Audio from '../audio/audio.model';
import { getBlockedObjectIdsFor } from '../userBlock/userBlock.service';

// Moderation: a playlist only exposes approved, non-blocked audios; without
// this it re-exposed processing/rejected/admin-blocked audios by reference.
// Same criterion the feed applies.
const AUDIO_VISIBLE_MATCH = {
    moderationStatus: ENUM_AUDIO_MODERATION_STATUS.READY,
    isBlocked: { $ne: true },
};

// Sortable-field allowlist. Raw `sortBy` was used as a $sort key, and an array
// (`?sortBy=a&sortBy=b`) became the key 'a,b' → Mongo rejects the FieldPath →
// 500. Unknown fields now fall back to the default order.
const PLAYLIST_SORT_FIELDS = new Set(['createdAt', 'updatedAt', 'name']);


// Narrows audioIds to what the user can see: READY, not admin-blocked, owner
// not in a block relation (either way). Keeps hidden audios from being saved by
// id on create/update. Returns ObjectId[] (order not preserved, irrelevant).
const filterVisibleAudioIds = async (
    userId: string,
    audioIds: unknown
): Promise<mongoose.Types.ObjectId[]> => {
    if (!Array.isArray(audioIds) || audioIds.length === 0) return [];
    const validIds = audioIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id as string))
        .map((id) => new mongoose.Types.ObjectId(id as string));
    if (validIds.length === 0) return [];
    const blockedObjectIds = await getBlockedObjectIdsFor(userId);
    const visible = await Audio.find({
        _id: { $in: validIds },
        moderationStatus: ENUM_AUDIO_MODERATION_STATUS.READY,
        isBlocked: { $ne: true },
        ...(blockedObjectIds.length ? { user: { $nin: blockedObjectIds } } : {}),
    }).select('_id');
    return visible.map((a) => a._id as mongoose.Types.ObjectId);
};

// Create Playlist
const createPlaylist = async (userId: string, payload: IPlaylist) => {
    // Only save audios the user can actually see; raw payload.audios let anyone
    // add hidden audios to a playlist knowing just the id.
    const visibleAudioIds = await filterVisibleAudioIds(userId, payload.audios);
    if (visibleAudioIds.length === 0) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'At least one valid, visible audio is required'
        );
    }
    // Allowlist (anti mass-assignment, as in update): only client content
    // fields; `user` is forced and never taken from the body.
    const result = await Playlist.create({
        name: payload.name,
        description: payload.description,
        tags: payload.tags,
        cover_image: payload.cover_image,
        audios: visibleAudioIds,
        user: userId,
    });
    return result;
};

// Get All Playlists with QueryBuilder
// const getAllPlaylists = async (query: Record<string, unknown>) => {
//     const playlistQuery = new QueryBuilder(
//         Playlist.find().populate({
//             path: 'user',
//             select: 'name profile_image',
//         }),
//         // .populate('audios'),
//         query
//     )
//         .search(['name', 'description'])
//         .filter()
//         .sort()
//         .paginate()
//         .fields();

//     const result = await playlistQuery.modelQuery;
//     const meta = await playlistQuery.countTotal();

//     return {
//         meta,
//         result,
//     };
// };

const getAllPlaylists = async (query: any, userId: string) => {
    // `userId` only feeds the block filter and isMyPlaylist, so a session without
    // a usable profileId degrades to the public list (as before), not 400. Avoids
    // `new ObjectId(<invalid>)` → BSONError, uncaught by globalErrorHandler → 500.
    const viewerId = mongoose.Types.ObjectId.isValid(String(userId || ''))
        ? String(userId)
        : null;
    // `parseInt(...) || 1` gave a NEGATIVE skip for ?page=-3 (same for ?limit=-5),
    // and Mongo rejects $skip → 500. Reuse the shared clamp helpers.
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit, 10, 100);
    const skip = (page - 1) * limit;

    const matchStage: any = {};

    // Block: hide playlists of users with a block relation (either way). This was
    // the only public surface ignoring it; a blocked user still showed up here
    // with name and photo.
    const blockedObjectIds = viewerId
        ? await getBlockedObjectIdsFor(viewerId)
        : [];
    if (blockedObjectIds.length) {
        matchStage.user = { $nin: blockedObjectIds };
    }

    // search (name, description)
    if (query.searchTerm) {
        matchStage.$or = [
            { name: { $regex: escapeRegex(query.searchTerm), $options: 'i' } },
            { description: { $regex: escapeRegex(query.searchTerm), $options: 'i' } },
        ];
    }

    const sortStage: any = {};
    const sortBy = String(query.sortBy || '');
    if (PLAYLIST_SORT_FIELDS.has(sortBy)) {
        sortStage[sortBy] = query.sortOrder === 'asc' ? 1 : -1;
    } else {
        sortStage.createdAt = -1;
    }

    const aggregationPipeline = [
        { $match: matchStage },

        // populate user
        {
            $lookup: {
                from: 'normalusers',
                localField: 'user',
                foreignField: '_id',
                as: 'user',
            },
        },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },

        // populate audios: only approved and non-blocked, same criterion as the
        // feed (a playlist must not re-expose audios under moderation).
        {
            $lookup: {
                from: 'audios', // collection name for Audio
                let: { audioIds: { $ifNull: ['$audios', []] } },
                pipeline: [
                    {
                        $match: {
                            $expr: { $in: ['$_id', '$$audioIds'] },
                            moderationStatus:
                                ENUM_AUDIO_MODERATION_STATUS.READY,
                            isBlocked: { $ne: true },
                            // Also hide audios of blocked owners: matchStage.user
                            // only hides the owner's playlist, so a referenced
                            // audio still slipped through.
                            ...(blockedObjectIds.length
                                ? { user: { $nin: blockedObjectIds } }
                                : {}),
                        },
                    },
                ],
                as: 'audios',
            },
        },

        // add isMyPlaylist and project user fields
        {
            $addFields: {
                isMyPlaylist: {
                    $cond: {
                        if: {
                            // No usable viewer: $eq against null never matches an
                            // ObjectId, so isMyPlaylist stays false — correct for a
                            // session without profile.
                            $eq: [
                                '$user._id',
                                viewerId
                                    ? new mongoose.Types.ObjectId(viewerId)
                                    : null,
                            ],
                        },
                        then: true,
                        else: false,
                    },
                },
            },
        },
        {
            $project: {
                name: 1,
                description: 1,
                tags: 1,
                cover_image: 1,
                audios: 1, // populated audios
                createdAt: 1,
                updatedAt: 1,
                isMyPlaylist: 1,
                user: {
                    _id: '$user._id',
                    name: '$user.name',
                    profile_image: '$user.profile_image',
                },
            },
        },

        // facet for pagination
        {
            $facet: {
                meta: [
                    { $count: 'total' },
                    {
                        $addFields: {
                            page,
                            limit,
                            totalPages: {
                                $ceil: { $divide: ['$total', limit] },
                            },
                        },
                    },
                ],
                result: [
                    { $sort: sortStage },
                    { $skip: skip },
                    { $limit: limit },
                ],
            },
        },
        {
            $project: {
                result: 1,
                meta: { $arrayElemAt: ['$meta', 0] },
            },
        },
    ];

    const data = await Playlist.aggregate(aggregationPipeline);

    return {
        meta: data[0]?.meta || { page, limit, total: 0, totalPages: 0 },
        result: data[0]?.result || [],
    };
};
const getMyPlaylists = async (
    userId: string,
    query: Record<string, unknown>
) => {
    const playlistQuery = new QueryBuilder(
        Playlist.find({ user: userId }).populate({
            path: 'audios',
            match: AUDIO_VISIBLE_MATCH,
        }),
        query
    )
        .search(['name', 'description'])
        .filter()
        .sort()
        .paginate()
        .fields();

    const result = await playlistQuery.modelQuery;
    const meta = await playlistQuery.countTotal();

    return {
        meta,
        result,
    };
};

// Get Playlist by ID
const getPlaylistById = async (playlistId: string, viewerId?: string) => {
    // Block: if the viewer has any block relation with the owner, the playlist
    // "does not exist" (404), and audios of blocked owners are hidden (same
    // criterion as the feed). No viewer used to be passed, so no block applied.
    const blockedObjectIds = viewerId
        ? await getBlockedObjectIdsFor(viewerId)
        : [];
    const audioMatch = blockedObjectIds.length
        ? { ...AUDIO_VISIBLE_MATCH, user: { $nin: blockedObjectIds } }
        : AUDIO_VISIBLE_MATCH;
    const playlist = await Playlist.findById(playlistId)
        .populate({ path: 'user', select: 'name profile_image' })
        .populate({ path: 'audios', match: audioMatch });
    if (!playlist) {
        throw new AppError(httpStatus.NOT_FOUND, 'Playlist not found');
    }
    if (blockedObjectIds.length) {
        const blockedIdSet = new Set(
            blockedObjectIds.map((id) => id.toString())
        );
        const ownerId = (
            (playlist.user as any)?._id ?? (playlist as any).user
        )?.toString();
        if (ownerId && blockedIdSet.has(ownerId)) {
            throw new AppError(httpStatus.NOT_FOUND, 'Playlist not found');
        }
    }
    return playlist;
};

// Update Playlist
const updatePlaylist = async (
    userId: string,
    playlistId: string,
    payload: Partial<IPlaylist>
) => {
    const playlist = await Playlist.findOne({ user: userId, _id: playlistId });
    if (!playlist) {
        throw new AppError(httpStatus.NOT_FOUND, 'Playlist not found');
    }
    // Allowlist (anti mass-assignment): sending the whole body let the owner
    // pass `user: <otherId>` and transfer ownership. `user` never from body.
    const ALLOWED_UPDATE_FIELDS = [
        'name',
        'description',
        'tags',
        'cover_image',
        'audios',
    ];
    const safePayload: Partial<IPlaylist> = {};
    for (const k of ALLOWED_UPDATE_FIELDS) {
        if ((payload as any)[k] !== undefined) {
            (safePayload as any)[k] = (payload as any)[k];
        }
    }

    // When audios change, filter them to visible ones (same as create).
    if ((safePayload as any).audios !== undefined) {
        const visibleAudioIds = await filterVisibleAudioIds(
            userId,
            (safePayload as any).audios
        );
        if (visibleAudioIds.length === 0) {
            throw new AppError(
                httpStatus.BAD_REQUEST,
                'At least one valid, visible audio is required'
            );
        }
        (safePayload as any).audios = visibleAudioIds;
    }

    // Guard: the schema .refine ran before the controller injected the uploaded
    // cover, so a file-only update arrived with an empty body. Here cover_image
    // is already set.
    if (Object.keys(safePayload).length === 0) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'At least one field must be provided for update'
        );
    }

    const updatedPlaylist = await Playlist.findByIdAndUpdate(
        playlistId,
        safePayload,
        { new: true }
    );

    if (payload.cover_image && playlist.cover_image) {
        deleteFileFromS3(playlist.cover_image);
    }

    return updatedPlaylist;
};

// Delete Playlist
// Route allows user/admin/superAdmin: an admin may delete ANY playlist
// (moderation), a regular user only their own. The old owner-only filter made
// admins (no NormalUser profileId) get 404 and broke moderation.
const deletePlaylist = async (
    userId: string,
    playlistId: string,
    isAdmin = false
) => {
    const filter = isAdmin
        ? { _id: playlistId }
        : { user: userId, _id: playlistId };
    const playlist = await Playlist.findOne(filter);
    if (!playlist) {
        throw new AppError(httpStatus.NOT_FOUND, 'Playlist not found');
    }
    const result = await Playlist.findByIdAndDelete(playlistId);
    if (playlist.cover_image) {
        deleteFileFromS3(playlist.cover_image);
    }
    return result;
};

const PlaylistService = {
    createPlaylist,
    getAllPlaylists,
    getPlaylistById,
    updatePlaylist,
    deletePlaylist,
    getMyPlaylists,
};

export default PlaylistService;
