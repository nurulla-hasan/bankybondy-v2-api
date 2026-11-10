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
    // BankyBondy domain types (Phase 2 of notifications); the front routes by type.
    // MATCH replaces GENERAL for match notifications. Adding values is additive.
    MATCH: 'MATCH',
    TRADE_PROPOSED: 'TRADE_PROPOSED',
    TRADE_COMPLETED: 'TRADE_COMPLETED',
    REVIEW: 'REVIEW',
    FRIEND_REQUEST: 'FRIEND_REQUEST',
    FRIEND_ACCEPTED: 'FRIEND_ACCEPTED',
    // Special moments of the proposed trade (Phase 3, Tanda B), same color language as
    // matching.colors.ts. GIFT_RECEIVED = given without asking; GIFT_GIVEN = giving.
    GIFT_RECEIVED: 'GIFT_RECEIVED',
    GIFT_GIVEN: 'GIFT_GIVEN',
    DOUBLE_SURPRISE: 'DOUBLE_SURPRISE',
    ENCOUNTER: 'ENCOUNTER',
    // Nudge to upgrade when hitting the link cap (25 Free / 100 Standard; not
    // Premium). Clickable → plans page. Mutable in settings.
    SUBSCRIPTION: 'SUBSCRIPTION',
    // Reminder to close a stale Ongoing trade (so pending reviews can apply).
    // Clickable → the trade chat (/message).
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
