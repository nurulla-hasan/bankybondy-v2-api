import { Types } from 'mongoose';

// Audio moderation/processing state.
// - processing: uploaded, AI moderation runs in background; not in feed yet.
// - ready: approved and visible in the feed.
// - rejected: content rejected by moderation; files removed from S3.
// - failed: TECHNICAL moderation failure (network/S3/ffmpeg/OpenAI/timeout).
//   Not a content verdict: files are kept so it can be reprocessed.
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
    trendingScore: number; // "what's rising" score, recomputed by the sweep
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

// Listener feedback: one document per (audio, user) combining an optional text
// comment and/or feeling tags. The upsert guarantees one opinion per user/audio.
export interface IAudioComment {
    _id?: Types.ObjectId;
    audio: Types.ObjectId;
    commentor: Types.ObjectId;
    text?: string;
    feelingTags: string[];
    createdAt?: Date;
    updatedAt?: Date;
}

// QUALIFIED listen event: a real listen (>=30s or >=40%), deduped by
// (audio, listener, day). Source of honest discovery/ranking and of `totalPlay`.
export interface IAudioListen {
    audio: Types.ObjectId;
    listener: Types.ObjectId;
    completion: number; // 0..1
    secondsListened: number;
    dayBucket: string; // 'YYYY-MM-DD' (UTC) — daily dedupe key
    createdAt?: Date;
    updatedAt?: Date;
}
