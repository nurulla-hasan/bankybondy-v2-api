import assert from 'node:assert/strict';
import { createBondLinkLifecycle } from './bondLink.lifecycle';

const A = '000000000000000000000001';
const B = '000000000000000000000002';
const C = '000000000000000000000003';
const LINK = '000000000000000000000010';
const copy = <T>(value: T): T => structuredClone(value);

// Deterministic transaction fake: attempts use snapshots; retry hooks install a
// competing commit. This tests our orchestration, not MongoDB's isolation.
function harness(status = 'Ongoing', signatures: string[] = []) {
    let state: any = {
        link: { _id: LINK, status, participants: [A, B], markAsCompletedBy: signatures },
        chat: { participants: [A, B], hiddenBy: [] },
    };
    let working: any;
    let active = false;
    let retry: ((state: any) => void) | undefined;
    let miss: 'signature' | 'transition' | undefined;
    let onMiss: ((state: any) => void) | undefined;
    let failChat = false;
    let reads = 0;
    const writes: any[] = [];
    const effects: string[] = [];
    const session = {
        async withTransaction(callback: () => Promise<unknown>) {
            for (;;) {
                working = copy(state);
                active = true;
                try {
                    const result = await callback();
                    active = false;
                    if (retry) {
                        const hook = retry;
                        retry = undefined;
                        hook(state);
                        continue;
                    }
                    state = working;
                    return result;
                } catch (error) {
                    active = false;
                    throw error;
                }
            }
        },
        async endSession() {},
    };
    const store = (options?: any) => {
        if (options?.session) assert.equal(options.session, session);
        return options?.session && active ? working : state;
    };
    const effect = (name: string) => {
        assert.equal(active, false, 'side effects must run after commit');
        effects.push(name);
    };
    const dependencies: any = {
        startSession: async () => session,
        BondLink: {
            findById: () => {
                reads++;
                const query: any = {
                    session: async (s: any) => copy(store({ session: s }).link),
                    then: (resolve: any, reject: any) => Promise.resolve(copy(state.link)).then(resolve, reject),
                };
                return query;
            },
            findOneAndUpdate: async (filter: any, update: any, options?: any) => {
                writes.push({ filter, update, options });
                const data = store(options);
                const kind = update.$addToSet ? 'signature' : 'transition';
                if (kind === miss) {
                    miss = undefined;
                    onMiss?.(data);
                    return null;
                }
                const link = data.link;
                if (!link || (filter.participants && !link.participants.includes(String(filter.participants)))) return null;
                if (typeof filter.status === 'string' && filter.status !== link.status) return null;
                if (filter.status?.$ne === link.status) return null;
                const before = copy(link);
                if (update.$addToSet) {
                    const id = String(update.$addToSet.markAsCompletedBy);
                    if (!link.markAsCompletedBy.includes(id)) link.markAsCompletedBy.push(id);
                }
                if (update.status || update.$set?.status) link.status = update.status || update.$set.status;
                return copy(options?.new ? link : before);
            },
        },
        Conversation: {
            updateOne: async (_filter: any, update: any, options?: any) => {
                const data = store(options);
                writes.push({ chat: true, options });
                if (failChat) throw new Error('chat write failed');
                const id = String(update.$pull.participants);
                data.chat.participants = data.chat.participants.filter((p: string) => p !== id);
                if (!data.chat.hiddenBy.includes(id)) data.chat.hiddenBy.push(id);
            },
        },
        BondRating: {
            updateMany: async () => effect('ratings'),
            distinct: async () => [B],
        },
        recomputeReputation: async () => effect('reputation'),
        sendNotification: async (data: any) => effect(`notify:${data.receiver}`),
        blockUser: async (_caller: string, id: string) => effect(`block:${id}`),
    };
    return {
        api: createBondLinkLifecycle(dependencies), effects, writes, session,
        get state() { return state; },
        get reads() { return reads; },
        retryWith: (hook: (state: any) => void) => { retry = hook; },
        missNext: (kind: 'signature' | 'transition', hook?: (state: any) => void) => { miss = kind; onMiss = hook; },
        failChat: () => { failChat = true; },
    };
}

const cases: Array<[string, () => Promise<void>]> = [
    ['partial and repeated signatures stay ongoing in the transaction', async () => {
        const h = harness();
        assert.equal((await h.api.markAsCompleteBond(A, LINK)).status, 'Ongoing');
        await h.api.markAsCompleteBond(A, LINK);
        assert.deepEqual(h.state.link.markAsCompletedBy, [A]);
        assert.deepEqual(h.effects, []);
        for (const write of h.writes) {
            assert.equal(write.filter.status, 'Ongoing');
            assert.equal(String(write.filter.participants), A);
            assert.equal(write.options.session, h.session);
        }
    }],
    ['completion wins, repeated completion writes nothing, reject conflicts with no effects', async () => {
        const h = harness('Ongoing', [A]);
        assert.equal((await h.api.markAsCompleteBond(B, LINK)).status, 'Completed');
        assert.deepEqual(h.state.link.markAsCompletedBy, [A, B]);
        for (const write of h.writes) {
            assert.equal(write.filter.status, 'Ongoing');
            assert.equal(String(write.filter.participants), B);
            assert.equal(write.options.session, h.session);
        }
        assert.deepEqual(h.effects, ['ratings', 'reputation', `notify:${A}`, `notify:${B}`]);
        const writes = h.writes.length;
        await h.api.markAsCompleteBond(B, LINK);
        assert.equal(h.writes.length, writes);
        await assert.rejects(h.api.rejectBondLink(A, LINK, [B]), { statusCode: 409 });
        assert.equal(h.writes.length, writes);
        assert.deepEqual(h.state.chat.participants, [A, B]);
        assert.deepEqual(h.effects, ['ratings', 'reputation', `notify:${A}`, `notify:${B}`]);
    }],
    ['cancellation wins and completion cannot add a signature', async () => {
        const h = harness('Ongoing', [A]);
        assert.deepEqual(await h.api.rejectBondLink(A, LINK, [A, B, B, C]), {
            status: 'Canceled', blocked: [B], leftChat: true,
        });
        const before = copy(h.state);
        const effects = [...h.effects];
        await assert.rejects(h.api.markAsCompleteBond(B, LINK), { statusCode: 409 });
        assert.deepEqual(h.state, before);
        assert.deepEqual(h.effects, effects);
        assert.deepEqual(h.state.link.markAsCompletedBy, [A]);
        assert.deepEqual(h.state.chat, { participants: [B], hiddenBy: [A] });
        assert.deepEqual(h.effects, [`block:${B}`, `notify:${B}`]);
        assert.equal(h.writes.find(w => w.chat).options.session, h.session);
    }],
    ['already canceled original participants may leave and request permitted blocks', async () => {
        const h = harness();
        await h.api.rejectBondLink(A, LINK);
        await h.api.rejectBondLink(A, LINK, [B, B, C, A]);
        const result = await h.api.rejectBondLink(B, LINK, [A]);
        assert.deepEqual(result, { status: 'Canceled', blocked: [A], leftChat: true });
        assert.deepEqual(h.state.chat, { participants: [], hiddenBy: [A, B] });
        assert.deepEqual(h.effects, [`notify:${B}`, `block:${B}`, `block:${A}`]);
    }],
    ['missing and nonparticipant errors keep the existing 404 message', async () => {
        for (const missing of [true, false]) {
            const h = harness('Completed');
            if (missing) h.state.link = null;
            for (const action of [h.api.markAsCompleteBond, h.api.rejectBondLink]) {
                await assert.rejects(action(C, LINK), { statusCode: 404, message: 'You are not participant of that bond' });
            }
            assert.deepEqual(h.writes, []);
            assert.deepEqual(h.effects, []);
        }
    }],
    ['chat failure rolls back cancellation and suppresses all effects', async () => {
        const h = harness();
        const before = copy(h.state);
        h.failChat();
        await assert.rejects(h.api.rejectBondLink(A, LINK, [B]), /chat write failed/);
        assert.deepEqual(h.state, before);
        assert.deepEqual(h.effects, []);
    }],
    ['retried completion sees canceled winner and preserves committed signatures', async () => {
        const h = harness('Ongoing', [A]);
        h.retryWith(state => { state.link.status = 'Canceled'; });
        await assert.rejects(h.api.markAsCompleteBond(B, LINK), { statusCode: 409 });
        assert.equal(h.state.link.status, 'Canceled');
        assert.deepEqual(h.state.link.markAsCompletedBy, [A]);
        assert.deepEqual(h.effects, []);
    }],
    ['retried rejection sees completed winner without chat or external effects', async () => {
        const h = harness('Ongoing', [A]);
        h.retryWith(state => { state.link.status = 'Completed'; state.link.markAsCompletedBy.push(B); });
        await assert.rejects(h.api.rejectBondLink(A, LINK, [B]), { statusCode: 409 });
        assert.equal(h.state.link.status, 'Completed');
        assert.deepEqual(h.state.chat, { participants: [A, B], hiddenBy: [] });
        assert.deepEqual(h.effects, []);
    }],
    ['retried canceled branch clears aborted notification winner but keeps allowed blocks', async () => {
        const h = harness();
        h.retryWith(state => { state.link.status = 'Canceled'; });
        await h.api.rejectBondLink(A, LINK, [B]);
        assert.deepEqual(h.effects, [`block:${B}`]);
        assert.deepEqual(h.state.chat, { participants: [B], hiddenBy: [A] });
    }],
    ['retried completed branch clears aborted rating and notification winner', async () => {
        const h = harness('Ongoing', [A]);
        h.retryWith(state => { state.link.status = 'Completed'; state.link.markAsCompletedBy.push(B); });
        assert.equal((await h.api.markAsCompleteBond(B, LINK)).status, 'Completed');
        assert.deepEqual(h.effects, []);
    }],
    ['already completed returns the saved document without filling missing signatures', async () => {
        const h = harness('Completed', [A]);
        assert.deepEqual(await h.api.markAsCompleteBond(B, LINK), h.state.link);
        assert.deepEqual(h.state.link.markAsCompletedBy, [A]);
        assert.deepEqual(h.writes, []);
        assert.deepEqual(h.effects, []);
    }],
    ['failed signature predicate preserves missing/nonparticipant errors on reread', async () => {
        for (const missing of [true, false]) {
            const h = harness();
            h.missNext('signature', state => {
                if (missing) state.link = null;
                else state.link.participants = [B];
            });
            await assert.rejects(h.api.markAsCompleteBond(A, LINK), {
                statusCode: 404, message: 'You are not participant of that bond',
            });
            assert.deepEqual(h.effects, []);
        }
    }],
    ['failed cancellation predicate resolves the already-canceled self-leave branch', async () => {
        const h = harness();
        h.missNext('transition', state => { state.link.status = 'Canceled'; });
        await h.api.rejectBondLink(A, LINK, [B]);
        assert.equal(h.state.link.status, 'Canceled');
        assert.deepEqual(h.state.chat, { participants: [B], hiddenBy: [A] });
        assert.deepEqual(h.effects, [`block:${B}`]);
    }],
    ['already-canceled chat failure cannot apply requested blocks', async () => {
        const h = harness('Canceled');
        const before = copy(h.state);
        h.failChat();
        await assert.rejects(h.api.rejectBondLink(A, LINK, [B]), /chat write failed/);
        assert.deepEqual(h.state, before);
        assert.deepEqual(h.effects, []);
    }],
    ['a zero signature predicate rereads canceled state before any effects', async () => {
        const h = harness();
        h.missNext('signature', state => { state.link.status = 'Canceled'; });
        await assert.rejects(h.api.markAsCompleteBond(A, LINK), { statusCode: 409 });
        assert.ok(h.reads >= 2);
        assert.deepEqual(h.effects, []);
        assert.deepEqual(h.state.link.markAsCompletedBy, []);
    }],
    ['a failed completion transition rolls back the signature rather than inventing completion', async () => {
        const h = harness('Ongoing', [A]);
        h.missNext('transition');
        await assert.rejects(h.api.markAsCompleteBond(B, LINK), { statusCode: 409 });
        assert.ok(h.reads >= 2);
        assert.deepEqual(h.state.link.markAsCompletedBy, [A]);
        assert.equal(h.state.link.status, 'Ongoing');
        assert.deepEqual(h.effects, []);
    }],
    ['a zero cancellation predicate rereads completed state without leaving or blocking', async () => {
        const h = harness();
        h.missNext('transition', state => { state.link.status = 'Completed'; });
        await assert.rejects(h.api.rejectBondLink(A, LINK, [B]), { statusCode: 409 });
        assert.ok(h.reads >= 2);
        assert.deepEqual(h.state.chat.participants, [A, B]);
        assert.deepEqual(h.effects, []);
    }],
];

export async function runBondLinkLifecycleTests(): Promise<{ pass: number; fail: number }> {
    let pass = 0, fail = 0;
    for (const [name, test] of cases) {
        try { await test(); pass++; }
        catch (error) { fail++; console.error('FAIL:', name, error); }
    }
    return { pass, fail };
}
