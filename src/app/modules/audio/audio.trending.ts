/* Trending (E1) score — PURE function, no DB, so it stays testable and tunable.
 * score = (listens × avgCompletion + weight × bookmarks) × freshness; ratings are excluded. */
export const TRENDING_BOOKMARK_WEIGHT = 5;
export const TRENDING_FRESHNESS_OFFSET_HOURS = 24;
export const TRENDING_FRESHNESS_GRAVITY = 1.2;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export interface TrendingSignals {
    listens?: number; // unique deduped listens (from E0)
    avgCompletion?: number; // 0..1 average listened fraction
    bookmarks?: number; // saved bookmarks
    ageHours?: number; // audio age in hours
}

export const computeTrendingScore = (s: TrendingSignals): number => {
    const listens = Math.max(0, Number(s?.listens) || 0);
    const comp = clamp01(Number(s?.avgCompletion) || 0);
    const bookmarks = Math.max(0, Number(s?.bookmarks) || 0);
    const ageHours = Math.max(0, Number(s?.ageHours) || 0);

    const engagement = listens * comp + TRENDING_BOOKMARK_WEIGHT * bookmarks;
    const freshness =
        1 /
        Math.pow(
            ageHours + TRENDING_FRESHNESS_OFFSET_HOURS,
            TRENDING_FRESHNESS_GRAVITY
        );
    return engagement * freshness;
};
