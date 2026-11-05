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

// Create Audio
router.post(
    '/create-audio',
    auth(USER_ROLE.user),
    // EC3 (Tanda 0): rate-limit por usuario ANTES de subir a S3 / disparar
    // ffmpeg+OpenAI. Frena abuso y costos descontrolados.
    audioUploadLimiter,
    uploadFile(),
    parseMultipartData,
    validateRequest(AudioValidations.createAudioValidationSchema),
    AudioController.createAudio
);

// Get All Audios
router.get(
    '/all-audios',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin, USER_ROLE.user),
    AudioController.getAllAudios
);
router.get('/my-audios', auth(USER_ROLE.user), AudioController.getMyAudios);

// D.5 (Tanda 2): polling del estado de moderacion asincrona de un audio propio.
router.get(
    '/moderation-status/:audioId',
    auth(USER_ROLE.user),
    AudioController.getModerationStatus
);

// Charlas publicas de un usuario (para su pagina de perfil). Prefijo estatico
// distinto (/by-user/:userId) para no colisionar con /single-audio/:audioId ni
// con las rutas /:audioId/feedback.
router.get(
    '/by-user/:userId',
    auth(USER_ROLE.user),
    AudioController.getAudiosByUser
);

// Get Audio by ID
router.get(
    '/single-audio/:audioId',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin, USER_ROLE.user),
    AudioController.getAudioById
);

// Update Audio
router.patch(
    '/update-audio/:audioId',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin, USER_ROLE.user),
    uploadFile(),
    parseMultipartData,
    validateRequest(AudioValidations.updateAudioValidationSchema),
    AudioController.updateAudio
);

// Delete Audio
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

// Sistema de feedback del oyente (comentario + feeling tags).
// Vocabulario de feeling tags (publico).
router.get('/feeling-tags', AudioController.getFeelingTags);

// E0: registrar una escucha CALIFICADA. El player la llama al cruzar el umbral
// (≥30s o ≥40%); el server valida, deduplica por día y hace real el totalPlay.
router.post(
    '/:audioId/listen',
    auth(USER_ROLE.user),
    audioListenLimiter,
    validateRequest(AudioValidations.recordListenValidationSchema),
    AudioController.recordListen
);

// Upsert del feedback propio para un audio (usuario autenticado).
router.post(
    '/:audioId/feedback',
    auth(USER_ROLE.user),
    validateRequest(AudioValidations.giveAudioFeedbackValidationSchema),
    AudioController.giveFeedback
);

// Listado paginado del feedback de un audio + agregados (publico).
// `optionalAuth`: la ruta sigue siendo PÚBLICA (sin sesión responde igual), pero
// si quien mira está logueado se lo identifica para poder ocultar los comentarios
// de usuarios bloqueados. El service ya tenía ese filtro escrito, condicionado a
// un `viewerId` que nunca llegaba porque no había ningún middleware de auth acá.
router.get(
    '/:audioId/feedback',
    optionalAuth(),
    AudioController.getAudioFeedback
);

// D.5 (Admin): endpoints de moderacion de audios para el panel de administracion.
// Listado sin filtros forzados (todos los estados/bloqueados), bloqueo/desbloqueo
// reversible y eliminacion definitiva.
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
