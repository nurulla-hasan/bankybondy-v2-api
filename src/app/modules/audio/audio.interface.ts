import { Types } from 'mongoose';

// D.5 (Tanda 2): estado de moderacion/procesamiento del audio.
// - processing: subido; la moderacion por IA (dialogo real, censura) corre en
//   segundo plano. Aun NO visible en el feed.
// - ready: aprobado; visible en el feed "Estamos charlando".
// - rejected: rechazado por la moderacion POR CONTENIDO (la IA dictamino que el
//   contenido no es valido). No visible. Se borran los archivos de S3.
// - failed: fallo TECNICO de la moderacion (red/S3/ffmpeg/OpenAI/timeout/JSON).
//   NO es un veredicto de contenido: se conservan los archivos de S3 para poder
//   reprocesar/reintentar. No visible en el feed.
export const ENUM_AUDIO_MODERATION_STATUS = {
    PROCESSING: 'processing',
    READY: 'ready',
    REJECTED: 'rejected',
    FAILED: 'failed',
} as const;

export type AudioModerationStatus =
    (typeof ENUM_AUDIO_MODERATION_STATUS)[keyof typeof ENUM_AUDIO_MODERATION_STATUS];

export interface IAudio {
    user: Types.ObjectId;
    audioTopic: Types.ObjectId;
    title: string;
    audio_url: string;
    description: string;
    cover_image: string;
    tags: string[];
    totalPlay: number;
    trendingScore: number; // E1: score de "lo que sube", recomputado por el sweep
    duration: number;
    totalRating: number;
    ratingCount: number;
    isBlocked: boolean;
    moderationStatus: AudioModerationStatus;
    moderationReason?: string;
    moderationAttempts?: number;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface IAudioRating {
    user: Types.ObjectId;
    audio: Types.ObjectId;
    rating: number;
}

// Sistema de feedback del oyente: un unico documento por (audio, usuario) que
// combina un comentario de texto opcional y/o "feeling tags" (que le hizo sentir
// el audio). El upsert garantiza una sola opinion por usuario y audio.
export interface IAudioComment {
    _id?: Types.ObjectId;
    audio: Types.ObjectId;
    commentor: Types.ObjectId;
    text?: string;
    feelingTags: string[];
    createdAt?: Date;
    updatedAt?: Date;
}

// E0: evento de escucha CALIFICADA. Registra que un usuario escuchó DE VERDAD un
// audio (≥30s o ≥40%), deduplicado por (audio, oyente, día). Es la materia prima
// del descubrimiento/ranking honesto (E1) y lo que hace real el `totalPlay`.
export interface IAudioListen {
    audio: Types.ObjectId;
    listener: Types.ObjectId;
    completion: number; // 0..1
    secondsListened: number;
    dayBucket: string; // 'YYYY-MM-DD' (UTC) — clave de dedupe diario
    createdAt?: Date;
    updatedAt?: Date;
}
