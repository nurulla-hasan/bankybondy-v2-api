/* eslint-disable @typescript-eslint/no-explicit-any */
/* Prueba pura de groupMemberIds (sin DB ni red).
 *
 * Blindan la regla que decide quién puede leer el roster: el CREADOR cuenta como
 * miembro aunque NO figure en `participants` del ChatGroup. Si se pierde, el
 * creador recibe 404 al leer su propio grupo — y como 404 también es la
 * respuesta de "no sos miembro", el bug se confunde con un grupo inexistente. */
import mongoose from 'mongoose';
import { groupMemberIds } from './chatGroup.service';

const creatorId = new mongoose.Types.ObjectId();
const memberId = new mongoose.Types.ObjectId();
const outsiderId = new mongoose.Types.ObjectId();

const populated = {
    participants: [{ _id: memberId, name: 'Ana', profile_image: '' }],
    creator: { _id: creatorId, name: 'Emilio', profile_image: '' },
};

type Case = [name: string, cond: boolean];

const cases: Case[] = [
    ['el creador cuenta aunque no esté en participants',
        groupMemberIds(populated).has(creatorId.toString())],
    ['los participantes también',
        groupMemberIds(populated).has(memberId.toString())],
    ['un ajeno no entra',
        !groupMemberIds(populated).has(outsiderId.toString())],
    ['creador SIN poblar (ObjectId pelado) sigue contando',
        groupMemberIds({ participants: [memberId], creator: creatorId }).has(creatorId.toString())],
    ['participantes sin poblar (ObjectIds pelados) cuentan',
        groupMemberIds({ participants: [memberId], creator: creatorId }).has(memberId.toString())],
    ['ids como strings (lo que devuelve un lean query)',
        groupMemberIds({ participants: [memberId.toString()], creator: creatorId.toString() }).size === 2],
    ['grupo sin participantes escritos todavía → solo el creador',
        groupMemberIds({ participants: [], creator: creatorId }).size === 1],
    ['participants ausente (docs viejos) → no revienta',
        groupMemberIds({ creator: creatorId }).has(creatorId.toString())],
    ['no hay duplicados si un cliente viejo metió al creador en participants',
        groupMemberIds({
            participants: [{ _id: creatorId }, { _id: memberId }],
            creator: { _id: creatorId },
        }).size === 2],
];

export const runChatGroupRosterTests = (): { pass: number; fail: number } => {
    let pass = 0,
        fail = 0;
    for (const [name, cond] of cases) {
        if (cond) pass++;
        else {
            fail++;
            // eslint-disable-next-line no-console
            console.error('FAIL:', name);
        }
    }
    return { pass, fail };
};
