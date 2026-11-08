import { isDeepStrictEqual } from 'node:util';
import type { mongo } from 'mongoose';

export const BOND_REFERENCE_INDEX = {
    key: { requestedBonds: 1, status: 1 } as const,
    options: { name: 'bond_reference_status', collation: { locale: 'simple' } },
};

export async function ensureBondReferenceIndex(collection: mongo.Collection, apply = false) {
    const indexes = await collection.listIndexes().toArray();
    const existing = indexes.find(index => index.name === BOND_REFERENCE_INDEX.options.name);
    if (existing && (!isDeepStrictEqual(Object.entries(existing.key), Object.entries(BOND_REFERENCE_INDEX.key)) ||
        existing.unique || existing.sparse || existing.hidden || existing.partialFilterExpression ||
        (existing.collation && !isDeepStrictEqual(existing.collation, BOND_REFERENCE_INDEX.options.collation)))) {
        throw new Error('Existing named reference index differs; refusing replacement');
    }
    if (!existing && apply) {
        await collection.createIndex(BOND_REFERENCE_INDEX.key, BOND_REFERENCE_INDEX.options);
        return ensureBondReferenceIndex(collection);
    }
    return { present: !!existing, name: BOND_REFERENCE_INDEX.options.name };
}
