/* eslint-disable @typescript-eslint/no-explicit-any */
import { Schema, model } from 'mongoose';
import {
    ENUM_AUDIO_MODERATION_STATUS,
    IAudio,
    IAudioComment,
    IAudioListen,
    IAudioRating,
} from './audio.interface';
import { FEELING_TAGS } from './feelingTags';

const audioSchema = new Schema<IAudio>(
    {
        user: {
            type: Schema.Types.ObjectId,
            required: true,
        },
        audioTopic: {
            type: Schema.Types.ObjectId,
            ref: 'Topic',
            required: true,
        },
        audio_url: {
            type: String,
            required: true,
        },
        title: { type: String, required: true, trim: true },
        description: { type: String },
        cover_image: { type: String, required: true },
        tags: { type: [String], default: [] },
        totalPlay: { type: Number, default: 0 },
        // E1: "trending" (lo que sube). Server-controlled; lo recomputa el sweep.
        trendingScore: { type: Number, default: 0 },
        totalRating: {
            type: Number,
            default: 0,
        },
        ratingCount: {
            type: Number,
            default: 0,
        },
        duration: { type: Number, required: true },
        isBlocked: { type: Boolean, default: false },
        // D.5 (Tanda 2): estado de moderacion asincrona. Nace en 'processing';
        // el worker en segundo plano lo pasa a 'ready' (aprobado), 'rejected'
        // (rechazo por contenido, borra S3) o 'failed' (fallo tecnico, conserva
        // S3 para reprocesar). El enum se deriva de ENUM_AUDIO_MODERATION_STATUS.
        moderationStatus: {
            type: String,
            enum: Object.values(ENUM_AUDIO_MODERATION_STATUS),
            default: ENUM_AUDIO_MODERATION_STATUS.PROCESSING,
            index: true,
        },
        moderationReason: { type: String, default: '' },
        // EC2 (Tanda 0): cuántas veces el sweep ya reintentó moderar un audio
        // `failed`. Con un tope (AUDIO_FAILED_MAX_RETRIES) evita reintentar para
        // siempre un audio que falla por una causa permanente.
        moderationAttempts: { type: Number, default: 0 },
    },
    { timestamps: true }
);

const audioRatingSchema = new Schema<IAudioRating>(
    {
        user: {
            type: Schema.Types.ObjectId,
            ref: 'NormalUser',
            required: true,
        },
        audio: {
            type: Schema.Types.ObjectId,
            ref: 'Audio',
            required: true,
        },
        rating: {
            type: Number,
            max: 5,
            required: true,
            min: 1,
        },
    },
    {
        timestamps: true,
    }
);

// Un usuario solo puede valorar un audio una vez (evita carrera de doble voto)
audioRatingSchema.index({ user: 1, audio: 1 }, { unique: true });

// Feedback del oyente (comentario + feeling tags). Un unico documento por
// (audio, usuario): el POST hace upsert sobre su propia opinion.
const audioCommentSchema = new Schema<IAudioComment>(
    {
        audio: {
            type: Schema.Types.ObjectId,
            ref: 'Audio',
            required: true,
            index: true,
        },
        commentor: {
            type: Schema.Types.ObjectId,
            ref: 'NormalUser',
            required: true,
        },
        text: {
            type: String,
            trim: true,
            maxlength: 500,
            default: '',
        },
        // Cada tag debe pertenecer al vocabulario controlado (valor canonico).
        feelingTags: {
            type: [String],
            enum: FEELING_TAGS,
            default: [],
        },
    },
    { timestamps: true }
);

// Una sola opinion por usuario y audio (habilita el upsert idempotente).
audioCommentSchema.index({ audio: 1, commentor: 1 }, { unique: true });

// E0: evento de escucha calificada. Materia prima del trending honesto.
const audioListenSchema = new Schema<IAudioListen>(
    {
        audio: { type: Schema.Types.ObjectId, ref: 'Audio', required: true },
        listener: {
            type: Schema.Types.ObjectId,
            ref: 'NormalUser',
            required: true,
        },
        completion: { type: Number, default: 0 },
        secondsListened: { type: Number, default: 0 },
        dayBucket: { type: String, required: true },
    },
    { timestamps: true }
);
// Dedupe: 1 escucha por (audio, oyente, día). El índice único es el candado de
// idempotencia (el 2º intento del mismo día tira 11000 y NO vuelve a sumar).
audioListenSchema.index(
    { audio: 1, listener: 1, dayBucket: 1 },
    { unique: true }
);

// Feed "más escuchados": orden por totalPlay dentro de lo visible. Índice para que
// el sort deje de ser COLLSCAN cuando totalPlay empiece a tener datos reales.
audioSchema.index({ moderationStatus: 1, isBlocked: 1, totalPlay: -1 });

// Feed "trending" (lo que sube): orden por trendingScore dentro de lo visible.
audioSchema.index({ moderationStatus: 1, isBlocked: 1, trendingScore: -1 });

const Audio = model<IAudio>('Audio', audioSchema);
export const AudioRating = model<IAudioRating>(
    'AudioRating',
    audioRatingSchema
);
export const AudioComment = model<IAudioComment>(
    'AudioComment',
    audioCommentSchema
);
export const AudioListen = model<IAudioListen>(
    'AudioListen',
    audioListenSchema
);
export default Audio;
