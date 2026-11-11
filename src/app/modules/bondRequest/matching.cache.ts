interface CachedMatch {
    bonds: { toString(): string }[];
    score: number;
    computedAt?: Date | string;
    computeRevision?: number;
}

interface CacheSettings {
    computeRevision: number;
    cacheTtlMinutes: number;
    serveTtlMinutes: number;
}

interface ComputeSeal {
    matchesComputedAt?: Date | string;
    matchesComputeRevision?: number;
}

export function selectMatchingCache<T extends CachedMatch>(
    rows: T[],
    settings: CacheSettings,
    seal: ComputeSeal,
    now = Date.now()
): { records: T[]; shouldRefresh: boolean } {
    const hasCurrentSeal = Boolean(seal.matchesComputedAt) &&
        (seal.matchesComputeRevision ?? 0) >= settings.computeRevision;
    const recentlyComputed = hasCurrentSeal &&
        now - new Date(seal.matchesComputedAt!).getTime() < settings.cacheTtlMinutes * 60000;
    const best = new Map<string, T>();
    for (const row of rows) {
        const age = row.computedAt ? now - new Date(row.computedAt).getTime() : Infinity;
        if (!(age < settings.serveTtlMinutes * 60000)) continue;
        if (hasCurrentSeal && (row.computeRevision ?? 0) < settings.computeRevision) continue;
        const key = row.bonds.map((id) => id.toString()).sort().join('|');
        const previous = best.get(key);
        const revision = row.computeRevision ?? 0;
        const previousRevision = previous?.computeRevision ?? 0;
        if (!previous || revision > previousRevision ||
            (revision === previousRevision && row.score > previous.score)) {
            best.set(key, row);
        }
    }
    const records = [...best.values()];
    const shouldRefresh = records.length === 0 ? !recentlyComputed : records.some((row) =>
        (row.computeRevision ?? 0) < settings.computeRevision ||
        now - new Date(row.computedAt!).getTime() >= settings.cacheTtlMinutes * 60000
    );
    return { records, shouldRefresh };
}
