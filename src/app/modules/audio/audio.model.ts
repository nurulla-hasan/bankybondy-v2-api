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
        // E1: "trending" (what's rising). Server-controlled; recomputed by the sweep.
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
        // D.5: async moderation state. Starts 'processing'; the background worker
        // moves it to 'ready' (approved), 'rejected' (content, deletes S3) or
        // 'failed' (technical, keeps S3 for retry).
        moderationStatus: {
            type: String,
            enum: Object.values(ENUM_AUDIO_MODERATION_STATUS),
            default: ENUM_AUDIO_MODERATION_STATUS.PROCESSING,
            index: true,
        },
        moderationReason: { type: String, default: '' },
        // EC2: how many times the sweep retried moderating a `failed` audio; the
        // AUDIO_FAILED_MAX_RETRIES cap stops permanent failures from looping.
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

// One rating per user per audio (guards against double-vote races).
audioRatingSchema.index({ user: 1, audio: 1 }, { unique: true });

// Listener feedback (comment + feeling tags): one doc per (audio, user); POST
// upserts the caller's own opinion.
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
        // Tags must belong to the controlled vocabulary (canonical values).
        feelingTags: {
            type: [String],
            enum: FEELING_TAGS,
            default: [],
        },
    },
    { timestamps: true }
);

audioCommentSchema.index({ audio: 1, commentor: 1 }, { unique: true });

// E0: qualified-listen event; the raw material for honest trending.
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
// One listen per (audio, listener, day): this unique index is the idempotency
// lock (a 2nd attempt the same day throws 11000 and never double-counts).
audioListenSchema.index(
    { audio: 1, listener: 1, dayBucket: 1 },
    { unique: true }
);

// "Most played" feed: sort by totalPlay within visible docs (avoids COLLSCAN).
audioSchema.index({ moderationStatus: 1, isBlocked: 1, totalPlay: -1 });

// "Trending" feed: sort by trendingScore within visible docs.
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
