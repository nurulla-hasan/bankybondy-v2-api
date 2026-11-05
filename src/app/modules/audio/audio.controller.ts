/* eslint-disable no-unused-vars */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import { getCloudFrontUrl } from '../../helper/mutler-s3-uploader';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import { ENUM_AUDIO_MODERATION_STATUS } from './audio.interface';
import AudioService from './audio.service';

// D.5 (Tanda 2): la subida NO bloquea la UI. Antes esperaba a
// analyzeConversationAudio (descarga S3 + transcode ffmpeg + transcripcion +
// analisis OpenAI) ANTES de responder, dejando el front "pensando". Ahora:
//  1) se guarda el audio en S3 (multer, ya hecho) y se crea el registro en
//     estado 'processing'; se responde de inmediato (202).
//  2) la moderacion por IA (ya configurada) corre en SEGUNDO PLANO y pasa el
//     audio a 'ready' o 'rejected'. No se agregan llamadas de IA nuevas.
// El front hace polling del estado (GET /audio/moderation-status/:audioId) o lo
// lee del registro (my-audios / single-audio) para saber cuando esta listo.
const createAudio = catchAsync(async (req, res) => {
    const audiFile: any = req.files?.audio;
    if (!audiFile) {
        throw new Error('Audio file is required');
    }

    req.body.audio_url = getCloudFrontUrl(audiFile[0].key);
    const file: any = req.files?.audio_cover;
    if (file) {
        req.body.cover_image = getCloudFrontUrl(file[0].key);
    }

    // Se crea el registro en 'processing' y se responde rapido.
    const result = await AudioService.createAudio(req.user.profileId, req.body);

    // Trabajo pesado (moderacion IA) desacoplado de la respuesta HTTP.
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

// D.5: polling del estado de moderacion de un audio propio.
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

// Get All Audios
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
// Get All Audios
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

// Charlas publicas de un usuario (para su pagina de perfil). Listado ligero.
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

// Get Audio by ID
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

// Update Audio
const updateAudio = catchAsync(async (req, res) => {
    // SEGURIDAD (borrado arbitrario de S3 + robo de autoría): las URLs de archivo
    // y el dueño se DESCARTAN del body del cliente antes de nada. Sólo pueden
    // venir del uploader (más abajo) o del registro existente.
    //
    // Sin esto: `validateRequest` valida una COPIA del body y no lo reescribe, así
    // que las claves que el schema no declara llegan intactas al service; y el
    // `safePayload` del service filtra contadores y moderación pero dejaba pasar
    // `audio_url` y `user`. Con eso alcanzaba para:
    //  - Borrar CUALQUIER archivo del bucket (foto de perfil, portada o audio de
    //    cualquier persona) en dos requests: una para apuntar el registro al
    //    archivo ajeno, otra para que `deleteFileFromS3(audio.audio_url)` lo borre.
    //    `deleteFileFromS3` valida el host del CDN pero NO la propiedad: eso es
    //    responsabilidad de quien lo llama, y acá no se hacía.
    //  - Regalarle un audio ya aprobado al perfil de otra persona (`user`).
    //  - Hacer que el servidor descargue una URL arbitraria al re-moderar.
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

// Delete Audio
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
// give rating
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

// Vocabulario controlado de feeling tags (publico).
const getFeelingTags = catchAsync(async (req, res) => {
    const result = AudioService.getFeelingTags();
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Feeling tags retrieved successfully',
        data: result,
    });
});

// Upsert del feedback del oyente (comentario + feeling tags) para un audio.
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

// Listado paginado (publico) del feedback de un audio + agregados de sensaciones.
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

// D.5 (Admin): listado de audios para el panel de administracion (todos los
// estados y bloqueados/no bloqueados). Filtrable por query.
const getAudiosForAdmin = catchAsync(async (req, res) => {
    const result = await AudioService.getAudiosForAdmin(req.query);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Audios retrieved successfully',
        data: result,
    });
});

// D.5 (Admin): bloqueo/desbloqueo reversible (toggle) de un audio.
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

// D.5 (Admin): eliminacion definitiva de un audio por el administrador.
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
