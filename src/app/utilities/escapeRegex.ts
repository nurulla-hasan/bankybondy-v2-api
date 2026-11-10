/**
 * Escapes regex metacharacters so a user string can be used literally in
 * `$regex` without ReDoS or pattern injection. Returns '' for null/undefined.
 */
export const escapeRegex = (s?: unknown): string =>
    String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
