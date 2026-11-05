import httpStatus from 'http-status';
import AppError from '../../error/appError';
import Audio from '../audio/audio.model';
import { ENUM_AUDIO_MODERATION_STATUS } from '../audio/audio.interface';
import { getBlockedIdsFor } from '../userBlock/userBlock.service';
import AudioBookmark from './audio.bookmark.model';

const audioBookmarkAddDelete = async (profileId: string, audioId: string) => {
    const audio = await Audio.findById(audioId);
    if (!audio) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    const bookmark = await AudioBookmark.findOne({
        user: profileId,
        audio: audioId,
    });
    if (bookmark) {
        await AudioBookmark.findOneAndDelete({
            user: profileId,
            audio: audioId,
        });
        return null;
    } else {
        // Solo se puede bookmarkear un audio VISIBLE (READY y no bloqueado). Antes
        // solo se chequeaba existencia → con el id se guardaban/reveían audios
        // rechazados/procesando/bloqueados. (El path de DELETE de arriba queda libre
        // para poder sacar un bookmark viejo de un audio que después se bloqueó.)
        const a = audio as unknown as {
            isBlocked?: boolean;
            moderationStatus?: string;
        };
        if (
            a.isBlocked ||
            a.moderationStatus !== ENUM_AUDIO_MODERATION_STATUS.READY
        ) {
            throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
        }
        // Bloqueo entre usuarios: no se puede guardar en favoritos el audio de
        // alguien con quien hay relación de bloqueo (en cualquier sentido). Sin
        // esto, con sólo el id se reexponía y guardaba el audio del que te bloqueó.
        // (El path de DELETE de arriba queda libre a propósito: poder sacar un
        // bookmark viejo aunque después haya aparecido el bloqueo.)
        const ownerId = (
            audio as unknown as { user?: { toString(): string } }
        ).user?.toString();
        if (ownerId && ownerId !== profileId?.toString()) {
            const blockedIds = await getBlockedIdsFor(profileId);
            if (blockedIds.includes(ownerId)) {
                throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
            }
        }
        try {
            const result = await AudioBookmark.create({
                user: profileId,
                audio: audioId,
            });
            return result;
        } catch (error: unknown) {
            // Carrera con el indice unico (user+audio): ya existe -> idempotente.
            if ((error as { code?: number })?.code === 11000) {
                return await AudioBookmark.findOne({
                    user: profileId,
                    audio: audioId,
                });
            }
            throw error;
        }
    }
};

// get bookmark from db
const getMyBookmarkFromDB = async (profileId: string) => {
    const result = await AudioBookmark.find({ user: profileId }).populate({
        path: 'audio',
        populate: { path: 'audioTopic' },
    });
    // Bloqueo entre usuarios: descartar además los favoritos cuyo DUEÑO esté en
    // relación de bloqueo (en cualquier sentido). Un audio que guardaste antes de
    // bloquear (o de ser bloqueado) no debe seguir apareciendo en tus favoritos.
    const blockedIds = new Set(await getBlockedIdsFor(profileId));
    // Guard (follow-up de AB): descartar bookmarks cuyo audio ya no corresponde
    // mostrar — borrado (audio == null tras populate), BLOQUEADO por admin, o que
    // NO está aprobado (moderationStatus != READY). Mismo criterio que el guard de
    // creación del bookmark: un audio que se bloqueó/rechazó después no debe seguir
    // apareciendo en la lista del usuario.
    return result.filter((bookmark) => {
        const audio = bookmark.audio as unknown as {
            isBlocked?: boolean;
            moderationStatus?: string;
            user?: { toString(): string };
        } | null;
        if (
            audio == null ||
            audio.isBlocked ||
            audio.moderationStatus !== ENUM_AUDIO_MODERATION_STATUS.READY
        ) {
            return false;
        }
        const ownerId = audio.user?.toString();
        if (ownerId && blockedIds.has(ownerId)) {
            return false;
        }
        return true;
    });
};

const audioBookmarkServices = {
    audioBookmarkAddDelete,
    getMyBookmarkFromDB,
};

export default audioBookmarkServices;
