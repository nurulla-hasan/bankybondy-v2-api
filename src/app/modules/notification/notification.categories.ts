import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';

// Categorías agrupadas para el SILENCIADO (Fase 3, Tanda C). El usuario silencia
// por CATEGORÍA (no por tipo suelto); cada categoría agrupa los tipos que le
// corresponden. Silenciar una categoría NO borra ni deja de crear la
// notificación: sólo hace que esos tipos no sumen al globito (el conteo de no
// vistas) NI aparezcan en la lista de la campana (opción a): "registra sin molestar".
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

// Categorías válidas (las que el front puede silenciar). Fuente de verdad única.
export const NOTIFICATION_CATEGORIES = Object.keys(NOTIFICATION_CATEGORY_TYPES);

/** Expande una lista de categorías silenciadas a los TIPOS a excluir del conteo. */
export const mutedTypesFromCategories = (categories?: string[]): string[] => {
    if (!Array.isArray(categories) || categories.length === 0) return [];
    const types: string[] = [];
    for (const c of categories) {
        const t = NOTIFICATION_CATEGORY_TYPES[c];
        if (t) types.push(...t);
    }
    return types;
};

/** Categoría a la que pertenece un tipo de notificación (o null si ninguna). */
export const categoryForType = (type?: string): string | null => {
    if (!type) return null;
    for (const [cat, types] of Object.entries(NOTIFICATION_CATEGORY_TYPES)) {
        if (types.includes(type)) return cat;
    }
    return null;
};

/** Filtra una lista arbitraria dejando sólo categorías válidas y sin duplicados. */
export const sanitizeCategories = (categories: unknown): string[] => {
    if (!Array.isArray(categories)) return [];
    return [...new Set(categories)].filter(
        (c): c is string =>
            typeof c === 'string' && NOTIFICATION_CATEGORIES.includes(c)
    );
};
