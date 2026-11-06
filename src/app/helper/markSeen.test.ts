/* eslint-disable @typescript-eslint/no-explicit-any */
/* Pruebas puras de markSeen, con la base de datos reemplazada por un fake.
 *
 * Lo que se blindan son las GUARDAS Y SU ORDEN, que es la parte que un cliente
 * puede tocar: un id que no es ObjectId no debe llegar jamás al `findById`, y un
 * no-participante no debe llegar jamás al `updateMany`. El write real se hace con
 * el id DEL DOCUMENTO ya validado, nunca con el valor que mandó el cliente. */
import mongoose from 'mongoose';
import { markSeen, seenQueryFor } from './markSeen';

const me = new mongoose.Types.ObjectId().toString();
const peer = new mongoose.Types.ObjectId().toString();
const realConversationId = new mongoose.Types.ObjectId();
const otherConversationId = new mongoose.Types.ObjectId();

type Case = [name: string, fn: () => Promise<boolean>];

const makeDeps = (conversation: any) => {
    const findCalls: unknown[] = [];
    const writeCalls: { conversationId: unknown; currentUserId: string }[] = [];
    return {
        findCalls,
        writeCalls,
        deps: {
            findConversation: async (id: unknown) => {
                findCalls.push(id);
                return conversation;
            },
            markMessagesSeen: async (conversationId: unknown, currentUserId: string) => {
                writeCalls.push({ conversationId, currentUserId });
                return { modifiedCount: 1 };
            },
        },
    };
};

const run = async (conversationId: unknown, conversation: any) => {
    const f = makeDeps(conversation);
    // Sin `io`: es el camino REST, que marca y responde sin emitir nada.
    const result = await markSeen({ conversationId, currentUserId: me }, f.deps);
    return { result, f };
};

const JUNK: unknown[] = [
    null,
    undefined,
    '',
    42,
    [],
    { $ne: null },
    'no-es-objectid',
    { $gte: realConversationId.toString() },
];

const cases: Case[] = [
    // — guarda 1: el id tiene que ser un ObjectId —
    ['payload crudo → invalid, y nunca llega al findById', async () => {
        for (const value of JUNK) {
            const { result, f } = await run(value, {
                _id: realConversationId,
                participants: [me, peer],
            });
            if (result !== 'invalid' || f.findCalls.length !== 0) return false;
        }
        return true;
    }],
    ['un ObjectId de verdad (objeto, no string) sí pasa', async () => {
        const { result, f } = await run(realConversationId, {
            _id: realConversationId,
            participants: [me, peer],
        });
        return result === 'seen' && f.findCalls.length === 1;
    }],

    // — guarda 2: participante (anti-IDOR) —
    ['conversación inexistente → not_found, sin write', async () => {
        const { result, f } = await run(otherConversationId.toString(), null);
        return result === 'not_found' && f.writeCalls.length === 0;
    }],
    ['no-participante → not_found, sin write', async () => {
        const { result, f } = await run(otherConversationId.toString(), {
            _id: otherConversationId,
            participants: [peer],
        });
        return result === 'not_found' && f.writeCalls.length === 0;
    }],
    ['participants ausente o vacío → not_found, no revienta', async () => {
        for (const participants of [undefined, null, []]) {
            const { result, f } = await run(otherConversationId.toString(), {
                _id: otherConversationId,
                participants,
            });
            if (result !== 'not_found' || f.writeCalls.length !== 0) return false;
        }
        return true;
    }],
    ['participantes como ObjectId (no strings) → visto', async () => {
        const { result } = await run(otherConversationId.toString(), {
            _id: otherConversationId,
            participants: [new mongoose.Types.ObjectId(me), new mongoose.Types.ObjectId(peer)],
        });
        return result === 'seen';
    }],

    // — el write —
    ['write: sobre el id DEL DOCUMENTO, no sobre el valor del cliente', async () => {
        // Id válido PERO distinto del que devuelve findById: el cliente no elige
        // sobre qué conversación se aplica el $addToSet.
        const { f } = await run(otherConversationId.toString(), {
            _id: realConversationId,
            participants: [me, peer],
        });
        return f.writeCalls.length === 1 && f.writeCalls[0].conversationId === realConversationId;
    }],
    ['write: el userId es el autenticado, no algo del payload', async () => {
        const { f } = await run(realConversationId.toString(), {
            _id: realConversationId,
            participants: [me, peer],
        });
        return f.writeCalls.length === 1 && f.writeCalls[0].currentUserId === me;
    }],
    ['write: la forma de la consulta ($addToSet idempotente, mis mensajes afuera)', async () => {
        const { filter, update } = seenQueryFor(realConversationId, me);
        return (
            filter.conversationId === realConversationId &&
            JSON.stringify(filter.msgByUserId) === JSON.stringify({ $ne: me }) &&
            JSON.stringify(update) === JSON.stringify({ $addToSet: { seenBy: me } }) &&
            // Un `$set` reemplazaría el `seenBy` completo: los lectores anteriores
            // dejarían de constar.
            !('$set' in update)
        );
    }],
];

export const runMarkSeenTests = async (): Promise<{ pass: number; fail: number }> => {
    let pass = 0,
        fail = 0;
    for (const [name, fn] of cases) {
        let ok = false;
        try {
            ok = await fn();
        } catch (err: any) {
            // eslint-disable-next-line no-console
            console.error('ERROR:', name, err?.message);
        }
        if (ok) pass++;
        else {
            fail++;
            // eslint-disable-next-line no-console
            console.error('FAIL:', name);
        }
    }
    return { pass, fail };
};
