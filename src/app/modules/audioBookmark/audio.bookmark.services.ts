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
        // Only visible audios (READY, not blocked) can be bookmarked. DELETE stays
        // open so stale bookmarks of now-blocked audios can be removed.
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
        // Block relation either way: the audio cannot be bookmarked. DELETE stays
        // open on purpose so old bookmarks can still be cleared.
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
            // Unique (user, audio) race: already exists → idempotent.
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

const getMyBookmarkFromDB = async (profileId: string) => {
    const result = await AudioBookmark.find({ user: profileId }).populate({
        path: 'audio',
        populate: { path: 'audioTopic' },
    });
    // Drop bookmarks whose owner is in a block relation either way.
    const blockedIds = new Set(await getBlockedIdsFor(profileId));
    // Drop bookmarks whose audio was deleted, blocked by an admin or is not READY.
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
