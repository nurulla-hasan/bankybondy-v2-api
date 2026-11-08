/**
 * Bond write transactions keep the durability/read semantics the original
 * link-creation transaction relied on. A session otherwise inherits the
 * connection defaults (the app connection does not set a majority write
 * concern), so pass these options explicitly to every withTransaction call
 * that mutates bond state.
 */
export const BOND_TRANSACTION_OPTIONS = {
    readConcern: { level: 'local' },
    writeConcern: { w: 'majority' },
    readPreference: 'primary',
} as const;
