import express from 'express';
import auth from '../../middlewares/auth';
import optionalAuth from '../../middlewares/optionalAuth';
import parseMultipartData from '../../middlewares/parseMultipartData';
import { USER_ROLE } from '../user/user.constant';
import AudioController from './audio.controller';
import validateRequest from '../../middlewares/validateRequest';
import AudioValidations from './audio.validation';
import { uploadFile } from '../../helper/mutler-s3-uploader';
import {
    audioUploadLimiter,
    audioListenLimiter,
} from '../../middlewares/rateLimiter';

const router = express.Router();

router.post(
    '/create-audio',
    auth(USER_ROLE.user),
    // EC3 (Tanda 0): per-user rate limit before S3 upload and ffmpeg+OpenAI cost.
    audioUploadLimiter,
    uploadFile(),
    parseMultipartData,
    validateRequest(AudioValidations.createAudioValidationSchema),
    AudioController.createAudio
);

// Two-step upload: stage files first, then create-audio receives the URLs as JSON.
// delete-upload cleans up files the dialog discarded before publishing.
router.post(
    '/upload-audio',
    auth(USER_ROLE.user),
    audioUploadLimiter,
    uploadFile(),
    AudioController.uploadAudioFiles
);
router.post(
    '/delete-upload',
    auth(USER_ROLE.user),
    AudioController.deleteUploadedAudioFiles
);

router.get(
    '/all-audios',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin, USER_ROLE.user),
    AudioController.getAllAudios
);
router.get('/my-audios', auth(USER_ROLE.user), AudioController.getMyAudios);

// D.5 (Tanda 2): poll async moderation status of one of your audios.
router.get(
    '/moderation-status/:audioId',
    auth(USER_ROLE.user),
    AudioController.getModerationStatus
);

// Public talks of a user (profile page). Static prefix /by-user/:userId avoids
// colliding with /single-audio/:audioId and /:audioId/feedback.
router.get(
    '/by-user/:userId',
    auth(USER_ROLE.user),
    AudioController.getAudiosByUser
);

router.get(
    '/single-audio/:audioId',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin, USER_ROLE.user),
    AudioController.getAudioById
);

router.patch(
    '/update-audio/:audioId',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin, USER_ROLE.user),
    uploadFile(),
    parseMultipartData,
    validateRequest(AudioValidations.updateAudioValidationSchema),
    AudioController.updateAudio
);

router.delete(
    '/delete-audio/:audioId',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin, USER_ROLE.user),
    AudioController.deleteAudio
);
router.post(
    '/give-rating/:audioId',
    auth(USER_ROLE.user),
    validateRequest(AudioValidations.giveRatingValidationSchema),
    AudioController.giveRating
);

// Listener feedback system (comment + feeling tags).
// Feeling tags vocabulary (public).
router.get('/feeling-tags', AudioController.getFeelingTags);

// E0: record a QUALIFIED listen. The player calls it past the threshold (≥30s or
// ≥40%); the server validates, dedupes per day and makes totalPlay real.
router.post(
    '/:audioId/listen',
    auth(USER_ROLE.user),
    audioListenLimiter,
    validateRequest(AudioValidations.recordListenValidationSchema),
    AudioController.recordListen
);

// Upsert your own feedback for an audio (authenticated user).
router.post(
    '/:audioId/feedback',
    auth(USER_ROLE.user),
    validateRequest(AudioValidations.giveAudioFeedbackValidationSchema),
    AudioController.giveFeedback
);

// Paginated feedback listing plus aggregates (public).
// `optionalAuth` keeps the route public but identifies logged-in viewers so
// blocked users' comments can be hidden (the service needed that `viewerId`).
router.get(
    '/:audioId/feedback',
    optionalAuth(),
    AudioController.getAudioFeedback
);

// D.5 (Admin): audio moderation endpoints for the admin panel — unfiltered listing,
// reversible block/unblock and permanent deletion.
router.get(
    '/admin/all-audios',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    AudioController.getAudiosForAdmin
);
router.patch(
    '/admin/block-unblock/:audioId',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    AudioController.blockUnblockAudioByAdmin
);
router.delete(
    '/admin/:audioId',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    AudioController.deleteAudioByAdmin
);

export const audioRoutes = router;
