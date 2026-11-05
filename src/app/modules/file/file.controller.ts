/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import AppError from '../../error/appError';
import { deleteFileFromS3 } from '../../helper/deleteFromS3';
import { getCloudFrontUrl } from '../../helper/mutler-s3-uploader';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';

// Prefijos S3 de los archivos de CONVERSACIÓN (lo único que el front borra por
// este endpoint, staged antes de enviar). Ver deleteFiles.
const CONVERSATION_PREFIXES = [
    'uploads/images/conversation_image/',
    'uploads/pdf/conversation_pdf/',
    'uploads/videos/conversation_video/',
];

const uploadConversationFiles = catchAsync(async (req, res) => {
    let images: string[] = [];
    let videos: string[] = [];
    let pdfs: string[] = [];
    if (req.files?.conversation_image) {
        images = req.files.conversation_image.map((file: any) => {
            return getCloudFrontUrl(file.key);
        });
    }

    if (req.files?.conversation_video) {
        videos = req.files.conversation_video.map((file: any) => {
            return getCloudFrontUrl(file.key);
        });
    }
    if (req.files?.conversation_pdf) {
        pdfs = req.files.conversation_pdf.map((file: any) => {
            return getCloudFrontUrl(file.key);
        });
    }

    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Files uploaded successfully',
        data: {
            images,
            videos,
            pdfs,
        },
    });
});

const deleteFiles = catchAsync(async (req, res) => {
    const files = req.body?.files;
    if (!Array.isArray(files) || files.some((f: any) => typeof f !== 'string')) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'files must be an array of URLs'
        );
    }
    // Seguridad (IDOR): antes se borraba CUALQUIER key S3 que el cliente pasara
    // (fotos de perfil, covers de proyecto/institución, banners de otros, etc.).
    // Ahora el endpoint se acota a los archivos de CONVERSACIÓN Y, además, a los
    // que pertenecen al que borra: las keys de chat se namespacean por dueño
    // (uploads/.../conversation_x/<profileId>/<archivo>) en el uploader, y acá se
    // valida que el segmento de dueño coincida con el profileId del que pide. Así
    // un usuario no puede borrar los adjuntos de chat de otro aunque tenga la URL.
    const ownerId = String((req.user as any)?.profileId || '');
    const isOwnConversationFile = (url: string): boolean => {
        try {
            const path = new URL(url).pathname.replace(/^\/+/, '');
            const prefix = CONVERSATION_PREFIXES.find((p) =>
                path.startsWith(p)
            );
            if (!prefix) return false;
            const firstSegment = path.slice(prefix.length).split('/')[0];
            return !!ownerId && firstSegment === ownerId;
        } catch {
            return false;
        }
    };
    if (!files.every(isOwnConversationFile)) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'You can only delete your own conversation files through this endpoint'
        );
    }
    await Promise.all(files.map((file: string) => deleteFileFromS3(file)));
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Files deleted successfully',
        data: null,
    });
});

const fileController = {
    uploadConversationFiles,
    deleteFiles,
};
export default fileController;
