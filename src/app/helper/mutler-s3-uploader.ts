/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { S3Client } from '@aws-sdk/client-s3';
import { Request } from 'express';
import multer from 'multer';
import multerS3 from 'multer-s3';
import AppError from '../error/appError';

/**
 * Configure and setup AWS S3 client
 */
const s3 = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    },
});

const ALLOWED_MIMETYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/jpg',
    'image/webp',
    'image/avif',
    'video/mp4',
    'video/mov',
    'video/quicktime',
    'video/mpeg',
    'video/ogg',
    'video/webm',
    'video/x-msvideo',
    'video/x-flv',
    'video/3gpp',
    'video/3gpp2',
    'video/x-matroska',
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-wav',
    'audio/ogg',
    'audio/webm',
    'audio/aac',
    'audio/flac',
    'audio/x-m4a',
    'audio/mp4',
    'application/pdf',
]);

/**
 * Setup file upload to AWS S3
 */
export const uploadFile = () => {
    const fileFilter = (req: Request, file: any, cb: any) => {
        const allowedFieldnames = [
            'image',
            'profile_image',
            'topic_icon',
            'category_image',
            'team_logo',
            'team_bg_image',
            'player_image',
            'player_bg_image',
            'reward_image',
            'audio',
            'audio_cover',
            'thumbnail',
            'chat_images',
            'chat_videos',
            'product_image',
            'banner',
            'playlist_cover',
            'topic_image',
            'profile_cover',
            'group_chat_image',
            'conversation_image',
            'conversation_pdf',
            'conversation_video',
        ];

        if (file.fieldname === undefined) {
            // Allow requests without any files
            cb(null, true);
        } else if (allowedFieldnames.includes(file.fieldname)) {
            // El navegador manda el tipo con parametros (p.ej. MediaRecorder de
            // Chrome: 'audio/webm;codecs=opus'). Comparar por igualdad exacta
            // rechazaba grabaciones validas y el cliente recibia un 500. Se
            // normaliza a la parte base del tipo antes de validar.
            const mimetype = (file.mimetype || '')
                .split(';')[0]
                .trim()
                .toLowerCase();
            if (ALLOWED_MIMETYPES.has(mimetype)) {
                cb(null, true);
            } else {
                // 400 (no 500): el archivo lo eligio el cliente, no es un fallo
                // interno del servidor.
                cb(new AppError(400, 'Invalid file type'));
            }
        } else {
            cb(new AppError(400, 'Invalid fieldname'));
        }
    };

    const storage = multerS3({
        s3: s3,
        bucket: process.env.AWS_S3_BUCKET_NAME || 'your-bucket-name',
        contentType: multerS3.AUTO_CONTENT_TYPE,
        // Removing ACL setting as your bucket doesn't support ACLs
        key: function (req, file, cb) {
            let uploadPath = '';

            // Maintain the same folder structure as before
            if (file.fieldname === 'profile_image') {
                uploadPath = 'uploads/images/profile';
            } else if (file.fieldname === 'category_image') {
                uploadPath = 'uploads/images/category';
            } else if (file.fieldname === 'video') {
                uploadPath = 'uploads/videos';
            } else if (file.fieldname === 'topic_icon') {
                uploadPath = 'uploads/images/topic_icon';
            } else if (file.fieldname === 'chat_images') {
                uploadPath = 'uploads/images/chat_image';
            } else if (file.fieldname === 'chat_videos') {
                uploadPath = 'uploads/videos/chat_videos';
            } else if (file.fieldname === 'banner') {
                uploadPath = 'uploads/images/banner_image';
            } else if (file.fieldname === 'team_bg_image') {
                uploadPath = 'uploads/images/team_bg_image';
            } else if (file.fieldname === 'playlist_cover') {
                uploadPath = 'uploads/images/playlist_cover';
            } else if (file.fieldname === 'audio_cover') {
                uploadPath = 'uploads/images/audio_cover';
            } else if (file.fieldname === 'audio') {
                uploadPath = 'uploads/audios';
            } else if (file.fieldname === 'thumbnail') {
                uploadPath = 'uploads/images/thumbnail';
            } else if (file.fieldname === 'topic_image') {
                uploadPath = 'uploads/images/audio_topic';
            } else if (file.fieldname === 'profile_cover') {
                uploadPath = 'uploads/images/profile_cover';
            } else if (file.fieldname === 'group_chat_image') {
                uploadPath = 'uploads/images/group_chat_image';
            } else if (file.fieldname === 'conversation_pdf') {
                uploadPath = 'uploads/pdf/conversation_pdf';
            } else if (file.fieldname === 'conversation_image') {
                uploadPath = 'uploads/images/conversation_image';
            } else if (file.fieldname === 'conversation_video') {
                uploadPath = 'uploads/videos/conversation_video';
            } else {
                uploadPath = 'uploads';
            }

            // Sanitize the filename just like in the original code
            const sanitizedOriginalName = file.originalname
                .replace(/\s+/g, '_')
                .replace(/[^\w.-]+/g, '');

            const name = Date.now() + '-' + sanitizedOriginalName;

            // IDOR de archivos subidos: los adjuntos de chat se namespacean por
            // dueño (profileId del que sube) desde siempre. Los archivos de audio
            // (audio y portada) hacen lo mismo desde la subida en dos pasos: así
            // /audio/delete-upload y /audio/create-audio pueden exigir que la URL
            // pertenezca al que la manda, y un usuario no puede borrar ni publicar
            // archivos de otro aunque conozca la URL.
            const OWNER_NAMESPACED_FIELDS = [
                'conversation_image',
                'conversation_pdf',
                'conversation_video',
                'audio',
                'audio_cover',
            ];
            const ownerId = (req as any)?.user?.profileId;
            const fullPath =
                OWNER_NAMESPACED_FIELDS.includes(file.fieldname) && ownerId
                    ? `${uploadPath}/${ownerId}/${name}`
                    : `${uploadPath}/${name}`;

            cb(null, fullPath);
        },
    });

    const upload = multer({
        storage: storage,
        fileFilter: fileFilter,
        limits: {
            fileSize: 50 * 1024 * 1024, // 50MB limit, adjust as needed
        },
    }).fields([
        { name: 'image', maxCount: 1 },
        { name: 'profile_image', maxCount: 1 },
        { name: 'category_image', maxCount: 2 },
        { name: 'sub_category_image', maxCount: 1 },
        { name: 'league_image', maxCount: 5 },
        { name: 'team_logo', maxCount: 1 },
        { name: 'team_bg_image', maxCount: 1 },
        { name: 'class_banner', maxCount: 1 },
        { name: 'player_bg_image', maxCount: 1 },
        { name: 'banner', maxCount: 1 },
        { name: 'audio_cover', maxCount: 1 },
        { name: 'audio', maxCount: 1 },
        { name: 'chat_videos', maxCount: 2 },
        { name: 'chat_images', maxCount: 7 },
        { name: 'topic_icon', maxCount: 1 },
        { name: 'topic_image', maxCount: 1 },
        { name: 'playlist_cover', maxCount: 1 },
        { name: 'profile_cover', maxCount: 1 },
        { name: 'group_chat_image', maxCount: 1 },
        { name: 'conversation_pdf', maxCount: 2 },
        { name: 'conversation_image', maxCount: 5 },
        { name: 'conversation_video', maxCount: 1 },
    ]);

    return upload;
};

// get cloud font url
export const getCloudFrontUrl = (s3FilePath: string): string => {
    return `${process.env.CLOUDFRONT_URL}/${s3FilePath}`;
};
