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

// Moderación: al leer una playlist SOLO se muestran audios aprobados y no
// bloqueados. Sin esto una playlist reexponía audios en 'processing'/'rejected'
// o bloqueados por un admin (bypass de moderación vía referencia). El feed ya
// filtra por esto; las playlists deben aplicar el MISMO criterio.
const AUDIO_VISIBLE_MATCH = {
    moderationStatus: ENUM_AUDIO_MODERATION_STATUS.READY,
    isBlocked: { $ne: true },
};

// Allowlist de campos ordenables. `sortBy` viene del cliente y se usaba CRUDO
// como clave del `$sort`: un `?sortBy=a&sortBy=b` llega como array, se convierte
// en la clave `'a,b'` y Mongo rechaza el FieldPath → 500. Con la allowlist, un
// campo desconocido cae al orden por defecto en vez de romper.
const PLAYLIST_SORT_FIELDS = new Set(['createdAt', 'updatedAt', 'name']);


// Filtra una lista de audioIds a SÓLO los que el usuario puede ver: aprobados
// (READY), no bloqueados por admin, y cuyo dueño no esté en relación de bloqueo
// (en cualquier sentido) con el usuario. Se usa al crear/editar playlists para
// que no se guarden por referencia audios que no deberían ser visibles con sólo
// conocer el id. Devuelve ObjectId[] (el orden no se preserva; no es relevante).
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
    // Sólo se guardan audios que el usuario efectivamente puede ver (aprobados, no
    // bloqueados por admin, y de gente que no está en relación de bloqueo). Antes
    // se guardaba `payload.audios` crudo: con sólo conocer el id se metían en una
    // playlist audios no visibles.
    const visibleAudioIds = await filterVisibleAudioIds(userId, payload.audios);
    if (visibleAudioIds.length === 0) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'At least one valid, visible audio is required'
        );
    }
    // Allowlist (anti mass-assignment, consistente con el update): solo campos de
    // contenido del cliente; `user` se fuerza y jamás viene del body.
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
    // `userId` sólo alimenta el filtro de bloqueo y el flag `isMyPlaylist`, así que
    // una sesión sin profileId usable NO justifica cortar con 400: este endpoint
    // devolvía 200 con la lista pública y así se conserva. Se degrada elegante,
    // igual que `getPlaylistById` con su viewer. (Ojo: `profileId: null` es el
    // DEFAULT del schema de User, no un caso exótico.) Lo que sí hay que evitar es
    // el `new ObjectId(<inválido>)` de más abajo: tira BSONError, que no es
    // CastError y por lo tanto NINGUNA rama del globalErrorHandler atrapa → 500.
    const viewerId = mongoose.Types.ObjectId.isValid(String(userId || ''))
        ? String(userId)
        : null;
    // Antes: `parseInt(...) || 1`. Con `?page=-3` daba skip NEGATIVO y Mongo
    // rechaza el `$skip` → 500. Igual con `?limit=-5`. Se reusa el helper común
    // (ya testeado) en vez de duplicar el clamp acá.
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit, 10, 100);
    const skip = (page - 1) * limit;

    const matchStage: any = {};

    // Bloqueo: ocultar las playlists de usuarios con los que hay relación de
    // bloqueo (en cualquier sentido). Era la ÚNICA superficie pública que no lo
    // aplicaba — el feed de audios, el buscador, los chats, los mensajes y las
    // notificaciones sí lo hacen. Alguien a quien bloqueaste te seguía apareciendo
    // acá con su nombre y su foto.
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

        // populate audios (solo aprobados y no bloqueados — mismo criterio que el
        // feed; una playlist no debe reexponer audios en moderación/rechazados/
        // bloqueados por referencia).
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
                            // Bloqueo entre usuarios: ocultar también los audios
                            // cuyo dueño está bloqueado (o me bloqueó). El filtro de
                            // arriba (matchStage.user) sólo tapa la playlist del
                            // dueño bloqueado; un audio ajeno referenciado dentro de
                            // una playlist visible se colaba igual.
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
                            // Sin viewer usable: `$eq` contra null nunca matchea un
                            // ObjectId → isMyPlaylist queda false para todas, que es
                            // exactamente lo correcto para una sesión sin perfil.
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
// Get All Playlists with QueryBuilder
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
    // Bloqueo entre usuarios: si el que mira está en relación de bloqueo (en
    // cualquier sentido) con el dueño de la playlist, ésta "no existe" para él
    // (404). Y los audios internos de dueños bloqueados se ocultan (mismo criterio
    // que el feed y getAllPlaylists). Antes esta función no recibía el viewer, así
    // que no aplicaba bloqueo alguno: con el id se veía la playlist del que te
    // bloqueó y sus audios.
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
    // MASS-ASSIGNMENT (allowlist): antes se hacía findByIdAndUpdate(id, payload) con
    // el body ENTERO, y como validateRequest NO recorta, el dueño podía mandar
    // `user: <otroId>` y TRANSFERIR la propiedad de la playlist (o corromper campos
    // internos). Solo se aceptan los campos editables por el usuario; `user` jamás
    // viene del body.
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

    // Si se actualizan los audios, filtrarlos a los visibles para el usuario
    // (mismo criterio que create): no meter por referencia audios ocultos.
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

    // Guard "hay algo para actualizar": el `.refine` del schema se sacó porque
    // corría ANTES de que el controller inyectara la portada subida (un update
    // sólo-con-archivo llegaba con body vacío y era rechazado). Acá el payload ya
    // trae `cover_image` si se subió un archivo, así que éste es el punto correcto.
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
// La ruta permite user/admin/superAdmin. Un admin puede borrar CUALQUIER playlist
// (moderación); un usuario común sólo la suya. Antes el service exigía dueño
// (`{ user, _id }`) siempre, así que un admin —que además no tiene profileId de
// NormalUser— recibía 404 y la acción de moderación quedaba rota.
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
