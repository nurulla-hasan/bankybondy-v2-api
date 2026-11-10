export const ENUM_BOND_REQUEST_STATUS = {
    WAITING_FOR_LINK: 'WAITING_FOR_LINK',
    ONGOING: 'ONGOING',
    COMPLETED: 'COMPLETED',
    CANCELED: 'CANCELED',
};

// Exchange modality: physical (with geo radius) or online (global).
export const ENUM_BOND_MODALITY = {
    PHYSICAL: 'physical',
    ONLINE: 'online',
} as const;

export type BondModality =
    (typeof ENUM_BOND_MODALITY)[keyof typeof ENUM_BOND_MODALITY];
