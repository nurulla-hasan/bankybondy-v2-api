/* Pagination clamp (single boundary): `?page`/`?limit` are client-controlled, so
 * an unbounded limit is a cheap DoS and a NaN/negative one corrupts page math.
 * Always clamp to sane integers here; default max 500 (same as QueryBuilder).
 */
// Careful with infinity: `Number('1e999')` is Infinity, and `$skip: Infinity` makes
// Mongo throw a 500. Any non-finite value means "no page given" → 1.
export const clampPage = (raw: unknown): number => {
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n >= 1 ? n : 1;
};

export const clampLimit = (
    raw: unknown,
    fallback = 10,
    max = 500
): number => {
    const n = Math.floor(Number(raw) || fallback);
    return Math.min(Math.max(1, n), max);
};
