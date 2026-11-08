import assert from 'node:assert/strict';
import BondRequest from './bondRequest.model';
import { canonicalBondText, publicBondData } from './bondIdentity';

export const runBondIdentityTests = () => {
    let pass = 0;
    let fail = 0;
    const check = (name: string, test: () => void) => {
        try { test(); pass++; } catch (error) { fail++; console.error(name, error); }
    };
    check('identity trims and folds case', () => assert.equal(canonicalBondText('  Piano  '), 'piano'));
    check('composed and decomposed accents share identity', () => assert.equal(canonicalBondText(' CAFÉ '), canonicalBondText('cafe\u0301')));
    check('accents remain meaningful', () => assert.notEqual(canonicalBondText('café'), canonicalBondText('cafe')));
    check('internal whitespace remains meaningful', () => assert.notEqual(canonicalBondText('a  b'), canonicalBondText('a b')));
    check('created documents keep vectors but hide only new internals', () => {
        const bond = new BondRequest({ user: '507f1f77bcf86cd799439011', offer: 'Piano', want: 'Guitar', offerVector: [1], wantVector: [2], integrityRevision: 3, offerKey: 'piano', wantKey: 'guitar' });
        const result = publicBondData(bond) as any;
        assert.deepEqual(result.offerVector, [1]);
        assert.deepEqual(result.wantVector, [2]);
        assert.equal(result.offer, 'Piano');
        assert.deepEqual(Object.keys(result).sort(), [
            '_id', 'description', 'isDeleted', 'isLinked', 'isPause', 'matchesGen', 'matchesNextAt',
            'modality', 'offer', 'offerVector', 'status', 'user', 'want', 'wantVector',
        ]);
        for (const field of ['integrityRevision', 'offerKey', 'wantKey']) assert.equal(Object.hasOwn(result, field), false);
        assert.equal(result.user.toString(), '507f1f77bcf86cd799439011');
    });
    check('lean populated responses preserve baseline keys and dates', () => {
        const at = new Date(0);
        const input = { meta: { total: 1 }, result: [{ requestedBonds: [{ offer: 'Piano', createdAt: at, offerKey: 'piano', wantKey: 'guitar', integrityRevision: 4, user: { name: 'Test' } }] }] };
        assert.deepEqual(publicBondData(input), { meta: { total: 1 }, result: [{ requestedBonds: [{ offer: 'Piano', createdAt: at, user: { name: 'Test' } }] }] });
        assert.equal(input.result[0].requestedBonds[0].offerKey, 'piano');
    });
    return { pass, fail };
};
