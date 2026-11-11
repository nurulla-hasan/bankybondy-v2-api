/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { S3Client } from '@aws-sdk/client-s3';
import { Request } from 'express';
import multer from 'multer';
import multerS3 from 'multer-s3';
import fs from 'fs';
import path from 'path';
import AppError from '../error/appError';

/** Shared S3 client for S3 uploads (when configured). */
const s3 = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    },
    ...(process.env.AWS_S3_ENDPOINT
        ? { endpoint: process.env.AWS_S3_ENDPOINT, forcePathStyle: true }
        : {}),
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

const getUploadPath = (fieldname?: string): string => {
    if (fieldname === 'profile_image') return 'uploads/images/profile';
    if (fieldname === 'category_image') return 'uploads/images/category';
    if (fieldname === 'video') return 'uploads/videos';
    if (fieldname === 'topic_icon') return 'uploads/images/topic_icon';
    if (fieldname === 'chat_images') return 'uploads/images/chat_image';
    if (fieldname === 'chat_videos') return 'uploads/videos/chat_videos';
    if (fieldname === 'banner') return 'uploads/images/banner_image';
    if (fieldname === 'team_bg_image') return 'uploads/images/team_bg_image';
    if (fieldname === 'playlist_cover') return 'uploads/images/playlist_cover';
    if (fieldname === 'audio_cover') return 'uploads/images/audio_cover';
    if (fieldname === 'audio') return 'uploads/audios';
    if (fieldname === 'thumbnail') return 'uploads/images/thumbnail';
    if (fieldname === 'topic_image') return 'uploads/images/audio_topic';
    if (fieldname === 'profile_cover') return 'uploads/images/profile_cover';
    if (fieldname === 'group_chat_image') return 'uploads/images/group_chat_image';
    if (fieldname === 'conversation_pdf') return 'uploads/pdf/conversation_pdf';
    if (fieldname === 'conversation_image') return 'uploads/images/conversation_image';
    if (fieldname === 'conversation_video') return 'uploads/videos/conversation_video';
    return 'uploads';
};

const OWNER_NAMESPACED_FIELDS = [
    'conversation_image',
    'conversation_pdf',
    'conversation_video',
    'audio',
    'audio_cover',
];

const computeFullPath = (fieldname: string | undefined, originalname: string, ownerId?: string): { dir: string; fullPath: string; fileName: string } => {
    const uploadPath = getUploadPath(fieldname);
    const sanitizedOriginalName = originalname
        .replace(/\s+/g, '_')
        .replace(/[^\w.-]+/g, '');
    const fileName = Date.now() + '-' + sanitizedOriginalName;
    const dir = fieldname && OWNER_NAMESPACED_FIELDS.includes(fieldname) && ownerId
        ? `${uploadPath}/${ownerId}`
        : uploadPath;
    return { dir, fullPath: `${dir}/${fileName}`, fileName };
};

/** Multer middleware storing uploads on local disk or S3 depending on STORAGE_DRIVER. */
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
            cb(null, true);
        } else if (allowedFieldnames.includes(file.fieldname)) {
            const mimetype = (file.mimetype || '')
                .split(';')[0]
                .trim()
                .toLowerCase();
            if (ALLOWED_MIMETYPES.has(mimetype)) {
                cb(null, true);
            } else {
                cb(new AppError(400, 'Invalid file type'));
            }
        } else {
            cb(new AppError(400, 'Invalid fieldname'));
        }
    };

    const isLocal = process.env.STORAGE_DRIVER === 'local' || !process.env.AWS_ACCESS_KEY_ID;

    const storage = isLocal
        ? multer.diskStorage({
              destination: function (req, file, cb) {
                  const ownerId = (req as any)?.user?.profileId;
                  const { dir } = computeFullPath(file.fieldname, file.originalname, ownerId);
                  const targetDir = path.join(process.cwd(), dir);
                  fs.mkdirSync(targetDir, { recursive: true });
                  cb(null, targetDir);
              },
              filename: function (req, file, cb) {
                  const ownerId = (req as any)?.user?.profileId;
                  const { fullPath, fileName } = computeFullPath(file.fieldname, file.originalname, ownerId);
                  (file as any).key = fullPath;
                  cb(null, fileName);
              },
          })
        : multerS3({
              s3: s3,
              bucket: process.env.AWS_S3_BUCKET_NAME || 'your-bucket-name',
              contentType: multerS3.AUTO_CONTENT_TYPE,
              key: function (req, file, cb) {
                  const ownerId = (req as any)?.user?.profileId;
                  const { fullPath } = computeFullPath(file.fieldname, file.originalname, ownerId);
                  cb(null, fullPath);
              },
          });

    const upload = multer({
        storage: storage,
        fileFilter: fileFilter,
        limits: {
            fileSize: 50 * 1024 * 1024, // 50 MB cap
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

// Build a CDN URL for an S3 key.
export const getCloudFrontUrl = (s3FilePath: string): string => {
    return `${process.env.CLOUDFRONT_URL}/${s3FilePath}`;
};
