import type { ClientSession, Model } from 'mongoose';
import type { IBondRequest } from './bondRequest.interface';
import { ENUM_BOND_REQUEST_STATUS } from './bondRequest.enum';

export const canonicalBondText = (value: string): string =>
    value.trim().normalize('NFC').toLowerCase().normalize('NFC');

// Migration-owned: do not register this index on the runtime schema before backfill.
export const BOND_IDENTITY_INDEX = {
    name: 'bond_identity_v1_unique',
    key: { user: 1, offerKey: 1, wantKey: 1 } as const,
    options: {
        name: 'bond_identity_v1_unique',
        unique: true,
        collation: { locale: 'simple' },
        partialFilterExpression: {
            status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
            isLinked: false,
            offerKey: { $type: 'string' },
            wantKey: { $type: 'string' },
        },
    },
};

export async function hasBondIdentity(
    model: Model<IBondRequest>, user: string, offer: string, want: string,
    session: ClientSession | null = null
): Promise<boolean> {
    const offerKey = canonicalBondText(offer);
    const wantKey = canonicalBondText(want);
    const active = { user, status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK, isLinked: { $ne: true } };
    if (await model.exists({ ...active, offerKey, wantKey }).collation({ locale: 'simple' }).session(session)) return true;
    const cursor = model.find({
        ...active,
        $or: [{ offerKey: { $exists: false } }, { wantKey: { $exists: false } }, { offerKey: null }, { wantKey: null }],
    }).select('offer want').session(session).lean().cursor({ batchSize: 100 });
    try {
        for await (const row of cursor) {
            if (canonicalBondText(row.offer) === offerKey && canonicalBondText(row.want) === wantKey) return true;
        }
    } finally {
        await cursor.close();
    }
    return false;
}

const internalFields = new Set(['integrityRevision', 'offerKey', 'wantKey']);

export function publicBondData<T>(value: T): T {
    if (value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(publicBondData) as T;
    const document = value as { toObject?: () => unknown };
    if (typeof document.toObject === 'function') return publicBondData(document.toObject()) as T;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !internalFields.has(key))
        .map(([key, item]) => [key, publicBondData(item)])) as T;
}
