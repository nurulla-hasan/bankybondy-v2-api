import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';

// Categories for MUTING (phase 3). Users mute by CATEGORY, not by single type.
// Muting never deletes or stops creating notifications: those types just stop
// counting toward the badge and stop showing in the bell list ("log without noise").
export const NOTIFICATION_CATEGORY_TYPES: Record<string, string[]> = {
    matches: [ENUM_NOTIFICATION_TYPE.MATCH],
    trueques: [
        ENUM_NOTIFICATION_TYPE.TRADE_PROPOSED,
        ENUM_NOTIFICATION_TYPE.TRADE_COMPLETED,
        ENUM_NOTIFICATION_TYPE.TRADE_REMINDER,
        ENUM_NOTIFICATION_TYPE.GIFT_RECEIVED,
        ENUM_NOTIFICATION_TYPE.GIFT_GIVEN,
        ENUM_NOTIFICATION_TYPE.DOUBLE_SURPRISE,
        ENUM_NOTIFICATION_TYPE.ENCOUNTER,
    ],
    resenas: [ENUM_NOTIFICATION_TYPE.REVIEW],
    amistades: [
        ENUM_NOTIFICATION_TYPE.FRIEND_REQUEST,
        ENUM_NOTIFICATION_TYPE.FRIEND_ACCEPTED,
    ],
    suscripcion: [ENUM_NOTIFICATION_TYPE.SUBSCRIPTION],
};

// Valid categories (what the front can mute). Single source of truth.
export const NOTIFICATION_CATEGORIES = Object.keys(NOTIFICATION_CATEGORY_TYPES);

/** Expands muted categories into the TYPES excluded from the count. */
export const mutedTypesFromCategories = (categories?: string[]): string[] => {
    if (!Array.isArray(categories) || categories.length === 0) return [];
    const types: string[] = [];
    for (const c of categories) {
        const t = NOTIFICATION_CATEGORY_TYPES[c];
        if (t) types.push(...t);
    }
    return types;
};

/** Category a notification type belongs to (or null). */
export const categoryForType = (type?: string): string | null => {
    if (!type) return null;
    for (const [cat, types] of Object.entries(NOTIFICATION_CATEGORY_TYPES)) {
        if (types.includes(type)) return cat;
    }
    return null;
};

/** Filters an arbitrary list down to valid, de-duplicated categories. */
export const sanitizeCategories = (categories: unknown): string[] => {
    if (!Array.isArray(categories)) return [];
    return [...new Set(categories)].filter(
        (c): c is string =>
            typeof c === 'string' && NOTIFICATION_CATEGORIES.includes(c)
    );
};
