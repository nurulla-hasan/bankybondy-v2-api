import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import BondRequest from '../app/modules/bondRequest/bondRequest.model';
import { BondLink } from '../app/modules/bondLink/bondLink.model';
import Conversation from '../app/modules/conversation/conversation.model';

export async function createBondsIntegrationSandbox(uri: string) {
    if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri)) throw new Error('Explicit BONDS_TEST_DATABASE_URL is required');
    const connection = await mongoose.createConnection(uri, {
        autoIndex: false, autoCreate: false, maxPoolSize: 5,
        serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000,
    }).asPromise();
    const prefix = `copilot_bonds_test_${randomBytes(16).toString('hex')}_`;
    const owned: string[] = [];
    const cleanup = async () => {
        try {
            for (const name of owned) {
                if (!name.startsWith(prefix)) throw new Error('Refusing cleanup outside owned test namespace');
                await connection.db!.dropCollection(name);
            }
        } finally { await connection.close(); }
    };
    try {
        const hello = await connection.db!.admin().command({ hello: 1 });
        if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('Transaction-capable MongoDB required');
        for (const suffix of ['bonds', 'links', 'conversations', 'users']) {
            const name = prefix + suffix;
            if (await connection.db!.listCollections({ name }).hasNext()) throw new Error('Test namespace collision');
            await connection.db!.createCollection(name);
            owned.push(name);
        }
        const bonds = connection.model('BondRequest', BondRequest.schema.clone(), prefix + 'bonds');
        const links = connection.model('BondLink', BondLink.schema.clone(), prefix + 'links');
        const conversations = connection.model('Conversation', Conversation.schema.clone(), prefix + 'conversations');
        const users = connection.model('NormalUser', new mongoose.Schema({
            name: String, bondLimit: { type: Number, default: 25 }, bondSeq: { type: Number, default: 0 },
            hasActiveBonds: Boolean, subscriptionType: String, subscriptionNudgeAt: Number,
            user: { type: mongoose.Schema.Types.ObjectId, ref: 'NormalUser' },
        }, { timestamps: true }), prefix + 'users');
        await bonds.createIndexes();
        await links.createIndexes();
        await conversations.createIndexes();
        return { connection, bonds, links, conversations, users, cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
