export const ENUM_PRODUCT_STATUS = {
    AVAILABLE: 'available',
    UNAVAILABLE: 'unavailable',
} as const;

export const ENUM_USER_STATUS = {
    IN_PROGRESS: 'in-progress',
    BLOCKED: 'blocked',
};

export const ENUM_ORDER_STATUS = {
    PENDING: 'PENDING',
    WAITING_FOR_PICK: 'WAITING_FOR_PICK',
    CANCELED: 'CANCELED',
    ACCEPTED: 'ACCEPTED',
    PICKED: 'PICKED',
    SHIPPED: 'SHIPPED',
    DELIVERED: 'DELIVERED',
    COMPLETED: 'COMPLETED',
};

export const ENUM_NOTIFICATION_TYPE = {
    COURSE: 'COURSE',
    FEEDBACK: 'FEEDBACK',
    CLASS: 'CLASS',
    ORDER: 'ORDER',
    GENERAL: 'GENERAL',
    PAYMENT: 'PAYMENT',
    // Tipos de dominio de BankyBondy (Fase 2 de notificaciones). El front los usa
    // para rutear por tipo (y, en Fase 3, ícono/color). MATCH reemplaza el uso de
    // GENERAL en las notificaciones de match. Agregar valores es aditivo: no rompe
    // las notificaciones ya guardadas (siguen siendo válidas).
    MATCH: 'MATCH',
    TRADE_PROPOSED: 'TRADE_PROPOSED',
    TRADE_COMPLETED: 'TRADE_COMPLETED',
    REVIEW: 'REVIEW',
    FRIEND_REQUEST: 'FRIEND_REQUEST',
    FRIEND_ACCEPTED: 'FRIEND_ACCEPTED',
    // Momentos especiales del trueque propuesto (Fase 3, Tanda B). Mismo idioma
    // de color del matcheo (matching.colors.ts): regalo = coral, doble sorpresa
    // = fucsia, doble vacío = encuentro (coral + charla). GIFT_RECEIVED = te dan
    // algo sin pedir nada; GIFT_GIVEN = das algo sin recibir nada.
    GIFT_RECEIVED: 'GIFT_RECEIVED',
    GIFT_GIVEN: 'GIFT_GIVEN',
    DOUBLE_SURPRISE: 'DOUBLE_SURPRISE',
    ENCOUNTER: 'ENCOUNTER',
    // Empujón a subir de plan al llegar al tope de vínculos (25 Free / 100 Standard;
    // no en Premium). Clickeable → página de planes. Apagable en el engranaje.
    SUBSCRIPTION: 'SUBSCRIPTION',
    // Recordatorio de cerrar un trueque viejo Ongoing (para que se apliquen las
    // reseñas en suspenso). Clickeable → el chat del trueque (/message).
    TRADE_REMINDER: 'TRADE_REMINDER',
};

export const ENUM_TRANSACTION_TYPE = {
    DONATION: 'Donation',
    SUBSCRIPTION: 'Subscription',
};
export const ENUM_PAYMENT_PURPOSE = {
    DONATE: 'DONATE',
    SUBSCRIPTION: 'SUBSCRIPTION',
};

export const ENUM_PAYMENT_STATUS = {
    PAID: 'PAID',
    UNPAID: 'UNPAID',
};

export const ENUM_TEST_TYPE = {
    THEORY: 'THEORY',
    ADI: 'ADI',
};
