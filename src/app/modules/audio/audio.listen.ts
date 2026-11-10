/* PURE semantics of a "qualified listen", no DB -> testable.
 *
 * A listen counts if the listener passed **>=30s OR >=40%** of the track
 * (whichever comes first). Dedupe by (audio, listener, day) and counting only
 * authenticated users (never the owner) live in the service.
 */
export const LISTEN_MIN_SECONDS = 30;
export const LISTEN_MIN_COMPLETION = 0.4; // 40%

export const isQualifiedListen = (input: {
    secondsListened?: unknown;
    completion?: unknown;
}): boolean => {
    const secs = Number(input?.secondsListened);
    const comp = Number(input?.completion);
    const okSecs = Number.isFinite(secs) && secs >= LISTEN_MIN_SECONDS;
    // completion is a 0..1 fraction; >1 is garbage and does not qualify on its
    // own (defense in depth, besides the endpoint clamp).
    const okComp =
        Number.isFinite(comp) && comp >= LISTEN_MIN_COMPLETION && comp <= 1;
    return okSecs || okComp;
};

// Daily dedupe key (UTC): one qualified listen per (audio, listener, day).
// A unique index on it makes counting idempotent.
export const dayBucketFor = (date: Date): string =>
    date.toISOString().slice(0, 10); // 'YYYY-MM-DD'
