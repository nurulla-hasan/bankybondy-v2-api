import BondRequest from './bondRequest.model';

type VecPath = 'offerVector' | 'wantVector';
interface Snap {
    docs: any[];
    users: string[];
    offer: (Float32Array | null)[];
    want: (Float32Array | null)[];
}

const SNAP_TTL_MS = Number(process.env.MATCH_KNN_SNAPSHOT_TTL_MS ?? 3000);
const cache = new Map<string, { at: number; p: Promise<Snap> }>();

const toUnitF32 = (v: unknown): Float32Array | null => {
    if (!Array.isArray(v) || v.length === 0) return null;
    const f = new Float32Array(v.length);
    let mag = 0;
    for (let i = 0; i < v.length; i++) {
        const x = typeof v[i] === 'number' ? (v[i] as number) : 0;
        f[i] = x;
        mag += x * x;
    }
    mag = Math.sqrt(mag);
    if (mag > 0) for (let i = 0; i < f.length; i++) f[i] /= mag;
    return f;
};

const dot = (a: Float32Array, b: Float32Array): number => {
    const n = Math.min(a.length, b.length);
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
};

const load = async (filter: Record<string, unknown>): Promise<Snap> => {
    const docs = await BondRequest.find(filter)
        .select('user offer want offerVector wantVector location updatedAt modality')
        .lean();
    return {
        docs,
        users: docs.map((d: any) => (d.user?._id || d.user)?.toString()),
        offer: docs.map((d: any) => toUnitF32(d.offerVector)),
        want: docs.map((d: any) => toUnitF32(d.wantVector)),
    };
};

const getSnap = (filter: Record<string, unknown>): Promise<Snap> => {
    const key = JSON.stringify(filter);
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < SNAP_TTL_MS) return hit.p;
    if (cache.size > 20) cache.clear();
    const p = load(filter);
    cache.set(key, { at: now, p });
    p.catch(() => cache.delete(key));
    return p;
};

export const knnSearch = async (
    path: VecPath,
    queryVector: number[],
    limit: number,
    baseFilter: Record<string, unknown>,
    geoFilter: Record<string, unknown>
): Promise<any[]> => {
    const { user, ...rest } = baseFilter as any;
    const excludeUser: string | undefined = user?.$ne?.toString();
    const snap = await getSnap({ ...rest, ...geoFilter });

    const q = toUnitF32(queryVector);
    if (!q) return [];
    const vecs = path === 'offerVector' ? snap.offer : snap.want;

    const scored: { i: number; s: number }[] = [];
    for (let i = 0; i < vecs.length; i++) {
        const v = vecs[i];
        if (!v) continue;
        if (excludeUser && snap.users[i] === excludeUser) continue;
        scored.push({ i, s: dot(q, v) });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).map(({ i, s }) => ({ ...snap.docs[i], score: s }));
};
