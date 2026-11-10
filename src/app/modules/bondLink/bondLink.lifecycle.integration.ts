import assert from 'node:assert/strict';
import { Types } from 'mongoose';
import type { ClientSession, Model } from 'mongoose';
import type { IBondLink } from './bondLink.interface';
import type { IConversation } from '../conversation/conversation.interface';
import { createBondLinkLifecycle } from './bondLink.lifecycle';
import type { BondLinkLifecycleDependencies } from './bondLink.lifecycle';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';

export interface BondLinkLifecycleIntegrationDependencies {
    links: Model<IBondLink>;
    conversations: Model<IConversation>;
    startSession: () => Promise<ClientSession>;
}

const WAIT_MS = 20_000;
const QUERY_MS = 5_000;

async function bounded<T>(promise: PromiseLike<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try {
        return await Promise.race([
            Promise.resolve(promise),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), WAIT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function barrier() {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    let consumed = false;
    return {
        entered, release,
        async pauseOnce() {
            if (consumed) return;
            consumed = true;
            enter();
            await bounded(released, 'release stale transaction snapshot');
        },
    };
}

/** Caller owns connection, collections and teardown; only injected UUID-named
 * collections are touched and non-database effects are recorded, not delivered.
 */
export async function runBondLinkLifecycleIntegration({
    links, conversations, startSession,
}: BondLinkLifecycleIntegrationDependencies): Promise<{ pass: number; fail: number }> {
    const uuid = /(?:[a-f\d]{8}[-_][a-f\d]{4}[-_][a-f\d]{4}[-_][a-f\d]{4}[-_][a-f\d]{12}|[a-f\d]{32})/i;
    assert.match(links.collection.name, uuid, 'links must use a newly allocated UUID collection');
    assert.match(conversations.collection.name, uuid, 'conversations must use a newly allocated UUID collection');
    assert.notEqual(links.collection.name, conversations.collection.name);
    assert.equal(links.db, conversations.db, 'injected models must share a connection');

    const sessions = new Set<ClientSession>();
    const pending = new Set<Promise<unknown>>();
    const gates: ReturnType<typeof barrier>[] = [];
    let pass = 0;

    function track<T>(operation: Promise<T>) {
        // Observe rejection immediately, even while the other actor owns a barrier.
        const result = operation.then(
            value => ({ ok: true as const, value }),
            error => ({ ok: false as const, error })
        );
        pending.add(result);
        void result.then(() => pending.delete(result));
        return result;
    }

    async function settle<T>(operation: Promise<T>, label: string): Promise<T> {
        const result = await bounded(track(operation), label);
        if (result.ok === false) throw result.error;
        return result.value;
    }

    async function seed(status = 'Ongoing') {
        const a = new Types.ObjectId();
        const b = new Types.ObjectId();
        const outsider = new Types.ObjectId();
        const link = await bounded(links.create({
            name: 'lifecycle integration', participants: [a, b], requestedBonds: [],
            status, markAsCompletedBy: [a],
        }), 'seed link');
        await bounded(conversations.create({
            participants: [a, b], hiddenBy: [], bondLink: link._id, type: 'bond-link-group',
        }), 'seed conversation');
        return { a: a.toString(), b: b.toString(), outsider: outsider.toString(), id: link._id.toString() };
    }

    async function saved(id: string) {
        const link = await links.findById(id).maxTimeMS(QUERY_MS).lean();
        const chat = await conversations.findOne({ bondLink: id }).maxTimeMS(QUERY_MS).lean();
        assert.ok(link);
        assert.ok(chat);
        return { link, chat };
    }

    function actor(gate?: ReturnType<typeof barrier>, failAfterChatWrite = false) {
        const owned: ClientSession[] = [];
        const effects: Array<{ kind: string; receiver?: string; type?: string }> = [];
        const prematureEffects: string[] = [];
        let reads = 0;
        let writes = 0;
        const record = (kind: string, details: { receiver?: string; type?: string } = {}) => {
            if (owned.some(session => session.inTransaction())) prematureEffects.push(kind);
            effects.push({ kind, ...details });
        };
        const instrumentedLinks = {
            findById(...args: any[]) {
                const query = (links.findById as Function).apply(links, args).maxTimeMS(QUERY_MS);
                const execute = query.exec.bind(query);
                query.exec = async () => {
                    const document = await execute();
                    reads++;
                    if (gate) {
                        // Consume once, before waiting: a driver retry never blocks again.
                        await gate.pauseOnce();
                    }
                    return document;
                };
                return query;
            },
            findOneAndUpdate(...args: any[]) {
                writes++;
                return (links.findOneAndUpdate as Function).apply(links, args).maxTimeMS(QUERY_MS);
            },
        } as BondLinkLifecycleDependencies['BondLink'];
        const dependencies: BondLinkLifecycleDependencies = {
            BondLink: instrumentedLinks,
            Conversation: {
                updateOne: async (...args: any[]) => {
                    const result = await (conversations.updateOne as Function).apply(conversations, args).maxTimeMS(QUERY_MS);
                    if (failAfterChatWrite) throw new Error('injected after transactional chat write');
                    return result;
                },
            } as unknown as BondLinkLifecycleDependencies['Conversation'],
            startSession: async () => {
                const session = await startSession();
                owned.push(session);
                sessions.add(session);
                const transact = session.withTransaction.bind(session);
                const deadline = Date.now() + WAIT_MS;
                session.withTransaction = ((callback: (s: ClientSession) => Promise<unknown>, options: any) => {
                    let attempts = 0;
                    return transact(async current => {
                        assert.ok(++attempts <= 5 && Date.now() < deadline, 'transaction retry budget exhausted');
                        return callback(current);
                    }, { ...options, maxCommitTimeMS: QUERY_MS, timeoutMS: WAIT_MS });
                }) as ClientSession['withTransaction'];
                return session;
            },
            BondRating: {
                updateMany: async () => { record('ratings'); return {}; },
                distinct: async () => [],
            } as unknown as BondLinkLifecycleDependencies['BondRating'],
            recomputeReputation: async () => { record('reputation'); },
            sendNotification: async (notification: any) => {
                record('notification', { receiver: String(notification.receiver), type: notification.type });
            },
            blockUser: (async (_caller: string, target: string) => {
                record('block', { receiver: target });
                return {};
            }) as BondLinkLifecycleDependencies['blockUser'],
        };
        return {
            api: createBondLinkLifecycle(dependencies), effects, prematureEffects,
            get reads() { return reads; },
            get writes() { return writes; },
        };
    }

    try {
        // The loser has already read Ongoing in a real transaction. The winner
        // commits before the loser writes, forcing a snapshot conflict and retry.
        for (const winnerCompletes of [true, false]) {
            const fixture = await seed();
            const gate = barrier();
            gates.push(gate);
            const loser = actor(gate);
            const winner = actor();
            const losing = track<{ status: string }>(winnerCompletes
                ? loser.api.rejectBondLink(fixture.a, fixture.id, [fixture.b])
                : loser.api.markAsCompleteBond(fixture.b, fixture.id));
            try {
                await bounded(gate.entered, 'loser reads Ongoing');
                const winning = track<{ status: string }>(winnerCompletes
                    ? winner.api.markAsCompleteBond(fixture.b, fixture.id)
                    : winner.api.rejectBondLink(fixture.a, fixture.id, [fixture.b]));
                const won = await bounded(winning, 'terminal winner commits');
                if (won.ok === false) throw won.error;
                assert.equal(won.value.status, winnerCompletes ? 'Completed' : 'Canceled');
            } finally {
                gate.release();
            }
            const lost = await bounded(losing, 'stale transaction retries');
            assert.equal(lost.ok, false, 'opposite terminal action must lose');
            if (lost.ok) throw new Error('opposite terminal action unexpectedly succeeded');
            assert.equal(lost.error.statusCode, 409);
            assert.ok(loser.reads >= 2, 'driver must retry and reread the committed terminal state');
            assert.deepEqual(loser.effects, []);
            const { link, chat } = await saved(fixture.id);
            assert.equal(link.status, winnerCompletes ? 'Completed' : 'Canceled');
            assert.deepEqual(link.markAsCompletedBy.map(String), winnerCompletes ? [fixture.a, fixture.b] : [fixture.a]);
            assert.deepEqual(chat.participants.map(String), winnerCompletes ? [fixture.a, fixture.b] : [fixture.b]);
            assert.deepEqual(chat.hiddenBy.map(String), winnerCompletes ? [] : [fixture.a]);
            const notifications = winner.effects.filter(effect => effect.kind === 'notification');
            assert.deepEqual(notifications.map(effect => effect.receiver).sort(),
                (winnerCompletes ? [fixture.a, fixture.b] : [fixture.b]).sort());
            assert.ok(notifications.every(effect => effect.type === (winnerCompletes
                ? ENUM_NOTIFICATION_TYPE.TRADE_COMPLETED : ENUM_NOTIFICATION_TYPE.GENERAL)));
            assert.equal(winner.effects.filter(effect => effect.kind === 'ratings').length, winnerCompletes ? 1 : 0);
            assert.equal(winner.effects.filter(effect => effect.kind === 'block').length, winnerCompletes ? 0 : 1);
            assert.deepEqual(winner.prematureEffects, []);
            assert.deepEqual(loser.prematureEffects, []);
            pass++;
        }

        {
            const fixture = await seed('Completed');
            const caller = actor();
            const before = await saved(fixture.id);
            for (let attempt = 0; attempt < 2; attempt++) {
                const completed = await settle(caller.api.markAsCompleteBond(fixture.b, fixture.id), 'idempotent completion');
                assert.equal(completed.status, 'Completed');
                assert.deepEqual(completed.markAsCompletedBy.map(String), [fixture.a]);
            }
            assert.deepEqual(await saved(fixture.id), before, 'including timestamps: completed retry is no-write');
            assert.equal(caller.writes, 0);
            assert.deepEqual(caller.effects, []);
            pass++;
        }

        {
            const fixture = await seed();
            const first = actor();
            const second = actor();
            await settle(first.api.rejectBondLink(fixture.a, fixture.id), 'first cancellation');
            for (let attempt = 0; attempt < 2; attempt++) {
                const rejected = await settle(second.api.rejectBondLink(fixture.b, fixture.id,
                    [fixture.a, fixture.a, fixture.b, fixture.outsider]), 'already-canceled original participant leave');
                assert.deepEqual(rejected, { status: 'Canceled', blocked: [fixture.a], leftChat: true });
            }
            const { link, chat } = await saved(fixture.id);
            assert.equal(link.status, 'Canceled');
            assert.deepEqual(link.participants.map(String), [fixture.a, fixture.b]);
            assert.deepEqual(link.markAsCompletedBy.map(String), [fixture.a]);
            assert.deepEqual(chat.participants, []);
            assert.deepEqual(chat.hiddenBy.map(String).sort(), [fixture.a, fixture.b].sort());
            assert.deepEqual(first.effects, [{ kind: 'notification', receiver: fixture.b, type: ENUM_NOTIFICATION_TYPE.GENERAL }]);
            assert.deepEqual(second.effects, [
                { kind: 'block', receiver: fixture.a }, { kind: 'block', receiver: fixture.a },
            ]);
            assert.deepEqual(first.prematureEffects, []);
            assert.deepEqual(second.prematureEffects, []);
            pass++;
        }

        {
            const fixture = await seed();
            const caller = actor(undefined, true);
            const before = await saved(fixture.id);
            await assert.rejects(settle(caller.api.rejectBondLink(fixture.a, fixture.id, [fixture.b]),
                'rollback after chat write'), /injected after transactional chat write/);
            assert.deepEqual(await saved(fixture.id), before, 'real rollback restores both link and chat');
            assert.deepEqual(caller.effects, []);
            pass++;
        }
        return { pass, fail: 0 };
    } finally {
        for (const gate of gates) gate.release();
        try {
            await bounded(Promise.allSettled([...pending]), 'drain terminal operations');
        } finally {
            await bounded(Promise.allSettled([...sessions].map(session => session.endSession())), 'close test sessions');
        }
    }
}
