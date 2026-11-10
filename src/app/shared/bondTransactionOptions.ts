/**
 * Bond writes keep majority write concern and primary reads: a session otherwise
 * inherits connection defaults (no majority). Pass to every withTransaction that
 * mutates bond state.
 */
export const BOND_TRANSACTION_OPTIONS = {
    readConcern: { level: 'local' },
    writeConcern: { w: 'majority' },
    readPreference: 'primary',
} as const;
