/* eslint-disable no-unused-vars */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import AppError from '../../error/appError';
import { getCloudFrontUrl } from '../../helper/mutler-s3-uploader';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import { ENUM_AUDIO_MODERATION_STATUS } from './audio.interface';
import AudioService from './audio.service';

// Upload does not block the UI: create the record as 'processing', reply 202 and
// run AI moderation in the background. Clients poll the status.
const createAudio = catchAsync(async (req, res) => {
    const ownerId = String(req.user.profileId);
    const audioFile: any = req.files?.audio?.[0];
    const coverFile: any = req.files?.audio_cover?.[0];

    // Two-step upload: files already in S3 arrive as URLs (validated against the
    // CDN and the owner's prefix). Inline multipart files win over body URLs.
    if (audioFile) {
        req.body.audio_url = getCloudFrontUrl(audioFile.key);
    } else if (typeof req.body.audio_url === 'string') {
        await AudioService.assertPreparedAudioUpload(
            ownerId,
            req.body.audio_url,
            'audio'
        );
    } else {
        throw new AppError(httpStatus.BAD_REQUEST, 'Audio file is required');
    }

    if (coverFile) {
        req.body.cover_image = getCloudFrontUrl(coverFile.key);
    } else if (typeof req.body.cover_image === 'string') {
        await AudioService.assertPreparedAudioUpload(
            ownerId,
            req.body.cover_image,
            'cover'
        );
    } else {
        throw new AppError(httpStatus.BAD_REQUEST, 'Cover image is required');
    }

    const result = await AudioService.createAudio(req.user.profileId, req.body);

    // AI moderation runs detached from the HTTP response.
    AudioService.processAudioModeration(
        result._id.toString(),
        result.audio_url
    ).catch(() => undefined);

    sendResponse(res, {
        statusCode: httpStatus.ACCEPTED,
        success: true,
        message:
            'Audio uploaded. It is being processed and will appear once approved.',
        data: {
            ...(typeof (result as any).toObject === 'function'
                ? (result as any).toObject()
                : result),
            moderationStatus: ENUM_AUDIO_MODERATION_STATUS.PROCESSING,
        },
    });
});

// Step 1 of the two-step upload: store files under the owner's prefix and
// return their URLs.
const uploadAudioFiles = catchAsync(async (req, res) => {
    const audioFile: any = req.files?.audio?.[0];
    const coverFile: any = req.files?.audio_cover?.[0];
    if (!audioFile && !coverFile) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'At least one file is required'
        );
    }

    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Files uploaded successfully',
        data: {
            audio_url: audioFile ? getCloudFrontUrl(audioFile.key) : null,
            cover_image: coverFile ? getCloudFrontUrl(coverFile.key) : null,
        },
    });
});

// Delete staged files that were never published (dialog cancelled or replaced).
const deleteUploadedAudioFiles = catchAsync(async (req, res) => {
    const files = req.body?.files;
    if (
        !Array.isArray(files) ||
        files.some((file: any) => typeof file !== 'string')
    ) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'files must be an array of URLs'
        );
    }
    const result = await AudioService.deleteUploadedAudioFiles(
        String(req.user.profileId),
        files
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Files deleted successfully',
        data: result,
    });
});

// Poll the moderation status of an owned audio.
const getModerationStatus = catchAsync(async (req, res) => {
    const { audioId } = req.params;
    const result = await AudioService.getModerationStatus(
        req.user.profileId,
        audioId
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Audio moderation status retrieved successfully',
        data: result,
    });
});

const getAllAudios = catchAsync(async (req, res) => {
    const result = await AudioService.getAllAudios(
        req.query,
        req.user?.profileId
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Audios retrieved successfully',
        data: result,
    });
});
const getMyAudios = catchAsync(async (req, res) => {
    const result = await AudioService.getMyAudios(
        req.user.profileId,
        req.query
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Audios retrieved successfully',
        data: result,
    });
});

// Public talks of a user (profile page), lightweight list.
const getAudiosByUser = catchAsync(async (req, res) => {
    const { userId } = req.params;
    const result = await AudioService.getAudiosByUser(
        userId,
        req.user?.profileId
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'User audios retrieved successfully',
        data: result,
    });
});

const getAudioById = catchAsync(async (req, res) => {
    const { audioId } = req.params;
    const result = await AudioService.getAudioById(
        audioId,
        req.user?.profileId
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Audio retrieved successfully',
        data: result,
    });
});

const updateAudio = catchAsync(async (req, res) => {
    // SECURITY: drop client-supplied file URLs and owner from the body; only the
    // uploader or the existing record may set them. Prevents deleting arbitrary
    // S3 files and gifting authorship of an audio.
    delete req.body.audio_url;
    delete req.body.cover_image;
    delete req.body.user;

    const audiFile: any = req.files?.audio;
    if (req.files?.audio) {
        req.body.audio_url = getCloudFrontUrl(audiFile[0].key);
    }
    const file: any = req.files?.audio_cover;
    if (req.files?.audio_cover) {
        req.body.cover_image = getCloudFrontUrl(file[0].key);
    }
    const { audioId } = req.params;
    const result = await AudioService.updateAudio(
        req.user.profileId,
        audioId,
        req.body
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Audio updated successfully',
        data: result,
    });
});

const deleteAudio = catchAsync(async (req, res) => {
    const { audioId } = req.params;
    const result = await AudioService.deleteAudio(req.user.profileId, audioId);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Audio deleted successfully',
        data: result,
    });
});
const giveRating = catchAsync(async (req, res) => {
    const { audioId } = req.params;
    const result = await AudioService.giveRating(
        req.user.profileId,
        audioId,
        req.body.rating
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Audio rating added successfully',
        data: result,
    });
});

// Public controlled vocabulary of feeling tags.
const getFeelingTags = catchAsync(async (req, res) => {
    const result = AudioService.getFeelingTags();
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Feeling tags retrieved successfully',
        data: result,
    });
});

// Upsert the listener's feedback (comment + feeling tags) for an audio.
const giveFeedback = catchAsync(async (req, res) => {
    const { audioId } = req.params;
    const result = await AudioService.upsertAudioFeedback(
        req.user.profileId,
        audioId,
        req.body
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Feedback saved successfully',
        data: result,
    });
});

// Public paginated feedback plus mood aggregates.
const getAudioFeedback = catchAsync(async (req, res) => {
    const { audioId } = req.params;
    const result = await AudioService.getAudioFeedback(
        audioId,
        req.query,
        req.user?.profileId
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Audio feedback retrieved successfully',
        data: result,
    });
});

// Admin listing: every moderation state, blocked or not.
const getAudiosForAdmin = catchAsync(async (req, res) => {
    const result = await AudioService.getAudiosForAdmin(req.query);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Audios retrieved successfully',
        data: result,
    });
});

// Admin toggle of the audio's blocked flag.
const blockUnblockAudioByAdmin = catchAsync(async (req, res) => {
    const { audioId } = req.params;
    const result = await AudioService.setAudioBlockedByAdmin(audioId);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Audio block status updated successfully',
        data: result,
    });
});

// Admin hard delete of an audio.
const deleteAudioByAdmin = catchAsync(async (req, res) => {
    const { audioId } = req.params;
    const result = await AudioService.deleteAudioByAdmin(audioId);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Audio deleted successfully',
        data: result,
    });
});

const recordListen = catchAsync(async (req, res) => {
    const { audioId } = req.params;
    const result = await AudioService.recordListen(
        req.user.profileId,
        audioId,
        req.body
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Listen recorded',
        data: result,
    });
});

const AudioController = {
    createAudio,
    uploadAudioFiles,
    deleteUploadedAudioFiles,
    getModerationStatus,
    getAllAudios,
    getAudioById,
    updateAudio,
    deleteAudio,
    getMyAudios,
    getAudiosByUser,
    giveRating,
    getFeelingTags,
    giveFeedback,
    getAudioFeedback,
    recordListen,
    getAudiosForAdmin,
    blockUnblockAudioByAdmin,
    deleteAudioByAdmin,
};

export default AudioController;
