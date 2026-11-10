/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from 'mongoose';
import { ENUM_GENDER } from '../user/user.enum';
import { ENUM_SUBSCRIPTION_TYPE } from './normalUser.enum';

export interface INormalUser {
    user: Types.ObjectId;
    // username: string;
    name: string;
    email: string;
    phone: string;
    profile_image: string;
    cover_image: string;
    gender: (typeof ENUM_GENDER)[keyof typeof ENUM_GENDER];
    dateOfBirth: Date;
    address: string;
    bio: string;
    skills: [Types.ObjectId];
    socialLinks: string[];
    subscriptionType: (typeof ENUM_SUBSCRIPTION_TYPE)[keyof typeof ENUM_SUBSCRIPTION_TYPE];
    bondLimit: number;
    // Manual plan override trail (who/when/why): the only path where a plan drops
    // (chargebacks) or rises without payment (fixes) — both move money.
    subscriptionSetBy?: Types.ObjectId;
    subscriptionSetAt?: Date;
    subscriptionSetReason?: string;
    // Full history of manual changes (append-only, capped at 50). The three fields
    // above denormalize the latest so listings avoid the array.
    subscriptionHistory?: {
        type?: string;
        by?: Types.ObjectId;
        at?: Date;
        reason?: string;
        from?: string;
    }[];
    // Last bondLimit already nudged; a plan change alters bondLimit and re-arms it.
    subscriptionNudgeAt?: number;
    // Checkout started but unpaid (URL reuse / anti-duplicate).
    pendingSubscriptionCheckout?: {
        plan?: 'Standard' | 'Premium';
        provider?: 'paypal' | 'mercadopago';
        url?: string;
        createdAt?: Date;
    };
    // Internal race guard: bumped inside the bond-creation transaction to force a
    // WriteConflict between concurrent creates by the same user. No business meaning.
    bondSeq?: number;
    bondsPublic?: boolean;
    // Privacy: false keeps the profile out of the People listing and search. Matching
    // and direct-link access are unaffected. Default true.
    listedInPeople?: boolean;
    // Internal (vinculosVivos.ts): has at least one live link.
    hasActiveBonds?: boolean;
    // Muted notification categories (Tanda C); they don't feed the badge.
    mutedNotificationCategories?: string[];
    // Digest opt-out (one-click List-Unsubscribe). true = no automatic digest;
    // transactional mail is unaffected.
    digestOptOut?: boolean;
    reputation?: {
        avg: number;
        count: number;
        score: number;
    };
    // User geolocation (GeoJSON Point [lng, lat]). Never exposed in People responses;
    // only used for "near" mode and to inherit location when creating a bond.
    location?: {
        type: 'Point';
        coordinates: [number, number];
    };
    locationUpdatedAt?: Date;
    locationMode?: 'auto' | 'manual';
}
