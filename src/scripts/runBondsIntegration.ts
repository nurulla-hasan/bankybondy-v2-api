import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { createBondsIntegrationSandbox } from './bondsIntegrationSandbox';
import { loadBondService } from './bondsServiceTestLoader';
import { BOND_IDENTITY_INDEX, hasBondIdentity } from '../app/modules/bondRequest/bondIdentity';
import { ENUM_BOND_REQUEST_STATUS } from '../app/modules/bondRequest/bondRequest.enum';
import { runBondLinkLifecycleIntegration } from '../app/modules/bondLink/bondLink.lifecycle.integration';
import { ensureBondReferenceIndex } from '../app/modules/bondLink/bondLink.indexes';

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
};
const bounded = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Test barrier timeout')), 15000); })]); }
    finally { clearTimeout(timer!); }
};

async function main() {
    const sandbox = await createBondsIntegrationSandbox(process.env.BONDS_TEST_DATABASE_URL || '');
    const { bonds, links, conversations, users, connection } = sandbox;
    let pass = 0;
    let fail = 0;
    const check = async (name: string, test: () => Promise<void>) => {
        try { await test(); pass++; console.log('PASS', name); }
        catch (error) { fail++; console.error('FAIL', name, error instanceof Error ? error.message : 'unknown'); }
    };
    let calls = 0;
    const startSession = () => connection.startSession();
    const mongooseDependency = { ...mongoose, startSession };
    const notification = async () => undefined;
    const requestDependencies: Record<string, unknown> = {
        mongoose: mongooseDependency, './bondRequest.model': bonds,
        '../normalUser/normalUser.model': users,
        '../normalUser/normalUser.services': { buildLooseRegex: (value: string) => new RegExp(value, 'i') },
        '../../helper/isTextSafe': { isTextSafeBatch: async () => { calls++; return [{}, {}, {}]; }, assertTextAllowed: () => {} },
        '../../utilities/embedding': { generateEmbedding: async () => { calls++; return [1]; } },
        '../bondMatch/bondMatch.model': {}, '../bondMatch/bondMatchFeed.model': {},
        './matching.feed': { topMatchKeys: () => [] },
        '../../middlewares/metrics': {}, '../../shared/logger': { logger: { warn() {}, error() {} } },
        '../userBlock/userBlock.service': { getBlockedIdsFor: async () => [] },
        '../bondLink/bondLink.model': { BondLink: links },
        '../conversation/conversation.model': conversations,
        '../bondLink/bondLink.enum': { ENUM_BOND_LINK_STATUS: { Ongoing: 'Ongoing', Completed: 'Completed', Canceled: 'Canceled' } },
        './matching.robot': { enqueueRecompute() {}, invalidateAndRefresh: async () => {}, MATCH_PRIORITY_USER: 1 },
        '../../helper/sendNotification': notification,
        '../normalUser/vinculosVivos': { recalcularVinculosVivos: async () => {} },
    };
    const linkDependencies: Record<string, unknown> = {
        mongoose: mongooseDependency, '../bondRequest/bondRequest.model': bonds, './bondLink.model': { BondLink: links },
        '../conversation/conversation.model': conversations,
        '../bondRequest/matching.robot': { invalidateAndRefresh: async () => {} },
        '../../helper/sendNotification': notification, '../bondRating/bondRating.model': {},
        '../bondRating/reputation.util': { recomputeReputation: async () => {} },
        '../userBlock/userBlock.service': { findBlockedPairAmong: async () => null, blockUser: async () => {} },
    };
    const requests = () => loadBondService('bondRequest/bondRequest.service.ts', requestDependencies);
    const linkService = () => loadBondService('bondLink/bondLink.service.ts', linkDependencies);
    const fixtures = async () => {
        const [a, b] = await users.create([{ name: 'sandbox A' }, { name: 'sandbox B' }]);
        const [first, second] = await bonds.create([
            { user: a._id, offer: 'Piano', want: 'Guitar', offerVector: [1], wantVector: [1] },
            { user: b._id, offer: 'Guitar', want: 'Piano', offerVector: [1], wantVector: [1] },
        ]);
        return { a, b, first, second, payload: { name: 'sandbox', participants: [String(a._id), String(b._id)], requestedBonds: [String(first._id), String(second._id)] } };
    };
    try {
        await check('five real terminal lifecycle scenarios', async () => {
            const result = await runBondLinkLifecycleIntegration({ links, conversations, startSession });
            assert.equal(result.fail, 0);
            assert.equal(result.pass, 5);
        });
        await check('delete wins after link precheck: no dangling link or conversation', async () => {
            const f = await fixtures();
            const entered = deferred(); const release = deferred();
            let firstSession = true;
            linkDependencies.mongoose = { ...mongoose, startSession: async () => {
                if (firstSession) { firstSession = false; entered.resolve(); await bounded(release.promise); }
                return connection.startSession();
            } };
            const create = linkService().createBondLink(f.payload, String(f.a._id)).then(() => 'created', (error: any) => error.statusCode);
            try {
                await bounded(entered.promise);
                await requests().deleteBondRequestFromDB(String(f.a._id), String(f.first._id));
            } finally { release.resolve(); }
            assert.equal(await bounded(create), 400);
            assert.equal(await links.countDocuments({ requestedBonds: f.first._id }), 0);
            linkDependencies.mongoose = mongooseDependency;
        });
        await check('ongoing link wins even after multiple completed references', async () => {
            const f = await fixtures();
            await links.create([0, 1, 2].map(() => ({ ...f.payload, status: 'Completed' })));
            await linkService().createBondLink(f.payload, String(f.a._id));
            await assert.rejects(() => requests().deleteBondRequestFromDB(String(f.a._id), String(f.first._id)), (error: any) => error.statusCode === 409);
            assert.ok(await bonds.exists({ _id: f.first._id }));
        });
        await check('completed history is soft-deleted; private revision never serialized', async () => {
            const f = await fixtures();
            await links.create({ ...f.payload, status: 'Completed' });
            const deleted = await requests().deleteBondRequestFromDB(String(f.a._id), String(f.first._id));
            assert.equal(deleted.isDeleted, true);
            assert.equal(Object.hasOwn(deleted.toObject(), 'integrityRevision'), false);
            assert.ok(await bonds.exists({ _id: f.first._id }));
        });
        await check('legacy raw variant rejected before external calls', async () => {
            const user = await users.create({ name: 'legacy' });
            await bonds.collection.insertOne({ user: user._id, offer: '  CAFE\u0301 ', want: ' Piano ', status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK, isLinked: false } as any);
            const before = calls;
            await assert.rejects(() => requests().createBondRequestIntoDB(String(user._id), { offer: 'café', want: 'piano' }), (error: any) => error.statusCode === 409);
            assert.equal(calls, before);
        });
        await check('concurrent canonical variants insert once before new index exists', async () => {
            const user = await users.create({ name: 'concurrent' });
            const allEntered = deferred(); let embeddings = 0;
            requestDependencies['../../utilities/embedding'] = { generateEmbedding: async () => {
                if (++embeddings === 4) allEntered.resolve();
                await bounded(allEntered.promise); return [1];
            } };
            const result = await Promise.allSettled([
                requests().createBondRequestIntoDB(String(user._id), { offer: '  Piano ', want: 'Guitar' }),
                requests().createBondRequestIntoDB(String(user._id), { offer: 'piano', want: 'guitar' }),
            ]);
            assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
            const saved = (result.find(row => row.status === 'fulfilled') as PromiseFulfilledResult<any>).value.toObject();
            assert.deepEqual(Object.keys(saved).sort(), [
                '__v', '_id', 'createdAt', 'description', 'isDeleted', 'isLinked', 'isPause', 'matchesGen', 'matchesNextAt',
                'modality', 'offer', 'offerVector', 'status', 'updatedAt', 'user', 'want', 'wantVector',
            ]);
            const rejected = result.find(row => row.status === 'rejected') as PromiseRejectedResult;
            assert.equal(rejected.reason.statusCode, 409);
            assert.equal(await bonds.countDocuments({ user: user._id }), 1);
            requestDependencies['../../utilities/embedding'] = { generateEmbedding: async () => [1] };
        });
        await check('matching serving preserves response without loading vectors', async () => {
            const f = await fixtures();
            await bonds.updateOne({ _id: f.first._id }, { $set: { matchesComputedAt: new Date(), lastServedAt: new Date(), offerVector: Array(1536).fill(0.1), wantVector: Array(1536).fill(0.2) } });
            let selected: any;
            const observedBonds = new Proxy(bonds, { get(target, key) {
                if (key === 'findOne') return (...args: any[]) => (target.findOne as any)(...args).transform((row: any) => { selected = row; return row; });
                return Reflect.get(target, key);
            } });
            const empty: any = { sort: () => empty, limit: () => empty, batchSize: () => empty, lean: async () => [] };
            const service = loadBondService('bondRequest/bondRequest.service.ts', {
                ...requestDependencies, './bondRequest.model': observedBonds,
                '../bondMatch/bondMatch.model': { find: () => empty }, '../bondMatch/bondMatchFeed.model': { find: () => empty },
                '../../middlewares/metrics': new Proxy({}, { get: () => ({ observe() {}, inc() {} }) }),
            });
            const result = await service.getMatchingBondRequest(String(f.a._id), String(f.first._id), {});
            assert.equal(result.status, 'ready'); assert.equal(result.total, 0); assert.equal(result.data.length, 0);
            for (const key of ['offerVector', 'wantVector', 'offer', 'want', 'user', 'location', 'radius', 'modality']) {
                assert.equal(Object.hasOwn(selected, key), false, `${key} must not be fetched by serving`);
            }
            const full = await bonds.findById(f.first._id).lean();
            console.log('Serving DB payload bytes', JSON.stringify({ full: Buffer.byteLength(JSON.stringify(full)), selected: Buffer.byteLength(JSON.stringify(selected)) }));
            empty.lean = async () => [{ bonds: [f.first._id, f.second._id], users: [f.a._id, f.b._id],
                score: 0.73, type: 'entry', computedAt: new Date(), parts: { sem: 0.8, rep: 0.6, prox: 1, fresh: 1 } }];
            const reduced = await service.getMatchingBondRequest(String(f.a._id), String(f.first._id), {});
            const fullSource = new Proxy(bonds, { get(target, key) {
                if (key === 'findOne') return (...args: any[]) => (target.findOne as any)(...args)
                    .transform(async (row: any) => row && target.findById(row._id).lean());
                return Reflect.get(target, key);
            } });
            const baseline = loadBondService('bondRequest/bondRequest.service.ts', {
                ...requestDependencies, './bondRequest.model': fullSource,
                '../bondMatch/bondMatch.model': { find: () => empty }, '../bondMatch/bondMatchFeed.model': { find: () => empty },
                '../../middlewares/metrics': new Proxy({}, { get: () => ({ observe() {}, inc() {} }) }),
            });
            const originalPayload = await baseline.getMatchingBondRequest(String(f.a._id), String(f.first._id), {});
            assert.equal(reduced.total, 1);
            assert.equal(JSON.stringify(reduced), JSON.stringify(originalPayload), 'Full and reduced projections must serve identical ranked matches');
        });
        await check('reference index reduces scanned documents without changing Ongoing priority', async () => {
            const target = new mongoose.Types.ObjectId();
            await links.collection.insertMany(Array.from({ length: 1000 }, (_, i) => ({
                requestedBonds: [i < 3 ? target : new mongoose.Types.ObjectId()],
                status: i === 2 ? 'Ongoing' : 'Completed', name: 'index fixture',
            })) as any);
            const query = () => links.find({ requestedBonds: target, status: { $in: ['Ongoing', 'Completed'] } })
                .select('status').sort({ status: -1 }).collation({ locale: 'simple' }).limit(1);
            const before: any = await query().explain('executionStats');
            await ensureBondReferenceIndex(connection.db!.collection(links.collection.name), true);
            const after: any = await query().explain('executionStats');
            assert.equal((await query())[0].status, 'Ongoing');
            assert.ok(after.executionStats.totalDocsExamined < before.executionStats.totalDocsExamined);
            console.log('Reference query documents examined', JSON.stringify({ before: before.executionStats.totalDocsExamined, after: after.executionStats.totalDocsExamined }));
        });
        await check('canonical index enforces identity and never becomes a schema auto-index', async () => {
            const modelIndexes = bonds.schema.indexes();
            assert.equal(modelIndexes.some(([, options]) => options.name === BOND_IDENTITY_INDEX.name), false);
            // This test uses its own clean user; legacy fixtures above intentionally remain outside the partial key domain.
            await bonds.collection.createIndex(BOND_IDENTITY_INDEX.key, BOND_IDENTITY_INDEX.options);
            const user = await users.create({ name: 'indexed' });
            await bonds.create({ user: user._id, offer: 'CAFÉ', want: 'Piano', offerVector: [1], wantVector: [1] });
            await assert.rejects(() => bonds.create({ user: user._id, offer: 'cafe\u0301', want: 'piano', offerVector: [1], wantVector: [1] }), (error: any) => error.code === 11000);
            assert.equal(await hasBondIdentity(bonds, String(user._id), ' café ', ' piano '), true);
        });
    } finally { await sandbox.cleanup(); }
    console.log(JSON.stringify({ pass, fail, existingCollectionsModified: false, temporaryCollectionsRemoved: true }));
    if (fail) process.exitCode = 1;
}

if (require.main === module) void main().catch(error => {
    console.error('Bonds integration failed:', error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
});
