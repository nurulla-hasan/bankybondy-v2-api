import assert from 'node:assert/strict';
import { mongo } from 'mongoose';
import {
    projectLegacyRepair, projectIdentityBackfill, observedStateGuard,
    makeWriteDecision, makeRollbackDecision, indexMatchesSpecification,
} from './bondMaintenance';
import { BOND_IDENTITY_INDEX } from './bondIdentity';

export function runBondMaintenanceTests() {
    let passed = 0;
    let failed = 0;
    const test = (name: string, fn: () => void) => {
        try { fn(); passed++; } catch (error) { failed++; console.error(name, error); }
    };
    const base = () => ({ _id: new mongo.ObjectId(), user: new mongo.ObjectId(),
        status: 'WAITING_FOR_LINK', isPause: false, isLinked: false,
        offer: '  Cafe\u0301  ', want: 'Tea', updatedAt: new Date(1234) });
    test('non-BSON identifiers and spoofed object tags block writes', () => {
        assert.ok(projectLegacyRepair({ ...base(), user: { _bsontype: 'ObjectId' } }).issues.length);
        assert.ok(projectLegacyRepair({ ...base(), _id: 'untrusted text' }).issues.length);
    });
    test('explicit null is paused, absent pause is untouched', () => {
        assert.deepEqual(projectLegacyRepair({ ...base(), isPause: null }).set, { isPause: true });
        const d = base(); delete d.isPause;
        assert.deepEqual(projectLegacyRepair(d).set, {});
    });
    test('missing link seeds absent schedule atomically only when becoming eligible', () => {
        const d = base(); delete d.isLinked;
        assert.deepEqual(projectLegacyRepair(d).set, { isLinked: false, matchesGen: 0, matchesNextAt: new Date(0) });
        assert.deepEqual(projectLegacyRepair({ ...d, isPause: null }).set, { isPause: true, isLinked: false });
        delete d.isPause;
        assert.deepEqual(projectLegacyRepair(d).set, { isLinked: false });
    });
    test('already eligible or non-waiting rows receive no unrelated scheduler repair', () => {
        assert.deepEqual(projectLegacyRepair(base()).set, {});
        const d = base(); delete d.isLinked;
        for (const status of ['ONGOING', 'COMPLETED', 'CANCELED']) {
            assert.deepEqual(projectLegacyRepair({ ...d, status }).set, { isLinked: false });
        }
        assert.ok(projectLegacyRepair({ ...d, status: ['WAITING_FOR_LINK'] }).issues.length);
    });
    test('existing valid scheduler state is preserved', () => {
        const d = { ...base(), matchesGen: 9, matchesNextAt: new Date(5000) }; delete d.isLinked;
        assert.deepEqual(projectLegacyRepair(d).set, { isLinked: false });
        delete d.matchesGen;
        assert.deepEqual(projectLegacyRepair(d).set, { isLinked: false, matchesGen: 0 });
    });
    for (const field of ['isPause', 'isLinked', 'isDeleted']) {
        for (const value of ['false', 0, [], [false], {}, undefined, null]) {
            if (field === 'isPause' && value === null) continue;
            test(`blocks malformed ${field}: ${JSON.stringify(value)}`, () => {
                const result = projectLegacyRepair({ ...base(), [field]: value });
                assert.ok(result.issues.length); assert.deepEqual(result.set, {});
            });
        }
    }
    test('deleted inconsistent rows block rather than reactivate', () => {
        for (const patch of [{ isLinked: false }, { isPause: null }, { isLinked: undefined }]) {
            assert.ok(projectLegacyRepair({ ...base(), isDeleted: true, isPause: true, isLinked: true, ...patch }).issues.length);
        }
        assert.deepEqual(projectLegacyRepair({ ...base(), isDeleted: true, isPause: true, isLinked: true }).set, {});
    });
    for (const patch of [{ matchesGen: null }, { matchesGen: -1 }, { matchesGen: 1.5 }, { matchesGen: [] }, { matchesNextAt: null }, { matchesNextAt: '2026-01-01' }, { matchesNextAt: new Date(NaN) }]) {
        test('malformed scheduler blocks: ' + JSON.stringify(patch), () => assert.ok(projectLegacyRepair({ ...base(), ...patch }).issues.length));
    }
    test('identity canonicalizes keys without public text/timestamp changes', () => {
        const d = base(); const decision = makeWriteDecision('identity', d)!;
        assert.deepEqual(decision.update, { $set: { offerKey: 'café', wantKey: 'tea' } });
        assert.equal(d.offer, '  Cafe\u0301  ');
        assert.equal(decision.manifest.before.updatedAt.getTime(), 1234);
        assert.equal(decision.manifest.after.updatedAt.getTime(), 1234);
        assert.equal('offer' in decision.manifest.before, false);
        assert.equal(makeWriteDecision('identity', { ...d, offerKey: 'café', wantKey: 'tea' }), null);
    });
    test('identity apply requires repair and valid scalar text', () => {
        const d = base(); delete d.isLinked;
        assert.ok(projectIdentityBackfill(d).issues.length);
        for (const offer of ['', '  ', [], null, 3]) assert.ok(projectIdentityBackfill({ ...base(), offer }).issues.length);
    });
    test('CAS guards absence separately from null and rejects array query expansion', () => {
        const d = base(); delete d.isLinked;
        const guard = observedStateGuard({ ...d, isPause: null });
        const serialized = JSON.stringify(guard);
        assert.ok(serialized.includes('"$type":"null"'));
        assert.ok(serialized.includes('"isLinked":{"$exists":false}'));
        assert.ok(serialized.includes('"$type":"$isPause"'));
        assert.ok(serialized.includes('$literal'));
    });
    test('rollback restores only tool fields, conditioned on complete observed state', () => {
        const d = base(); delete d.isLinked;
        const decision = makeWriteDecision('repair', d)!;
        const after = { ...d, ...decision.update.$set };
        const rollback = makeRollbackDecision(decision.manifest, after)!;
        assert.deepEqual(rollback.update, { $unset: { isLinked: '', matchesGen: '', matchesNextAt: '' } });
        assert.equal(makeRollbackDecision(decision.manifest, { ...after, matchesGen: 1 }), null);
        assert.equal(makeRollbackDecision(decision.manifest, { ...after, updatedAt: new Date(999) }), null);
        assert.equal(makeRollbackDecision(decision.manifest, { ...after, offer: 'new offer' }), null);
        assert.equal(makeRollbackDecision(decision.manifest, { ...after, integrityRevision: 1 }), null);
    });
    test('index verification checks exact named ordered key and options', () => {
        const spec = { name: BOND_IDENTITY_INDEX.name, key: BOND_IDENTITY_INDEX.key, ...BOND_IDENTITY_INDEX.options };
        assert.equal(indexMatchesSpecification(spec), true);
        for (const patch of [{ name: 'other' }, { unique: false }, { sparse: true }, { hidden: true }, { collation: { locale: 'en' } }, { partialFilterExpression: { status: 'WAITING_FOR_LINK' } }, { key: { offerKey: 1, user: 1, wantKey: 1 } }]) {
            assert.equal(indexMatchesSpecification({ ...spec, ...patch }), false);
        }
    });
    return { pass: passed, fail: failed };
}
