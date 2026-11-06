/* Prueba pura del mapeo tipo → campo a poblar (sin DB ni red).
 *
 * `getSingleConversation` puebla UN solo campo por llamada, y ese campo es lo que
 * la fila de la lista dibuja (el par, el grupo, el vínculo). Un mapeo equivocado
 * no da error: la fila llega sin nombre y el chat aparece roto en silencio. */
import { ENUM_CONVERSATION_TYPE } from '../modules/conversation/conversation.enum';
import { fieldForType } from './emitConversationSnapshots';

type Case = [name: string, cond: boolean];

const cases: Case[] = [
    ['uno a uno → participants (el par, con nombre y foto)',
        fieldForType(ENUM_CONVERSATION_TYPE.oneToOne) === 'participants'],
    ['chat grupal → chatGroup (el nombre del grupo)',
        fieldForType(ENUM_CONVERSATION_TYPE.chatGroup) === 'chatGroup'],
    ['vínculo → bondLink',
        fieldForType(ENUM_CONVERSATION_TYPE.bondLinkGroup) === 'bondLink'],
    ['proyecto → project',
        fieldForType(ENUM_CONVERSATION_TYPE.projectGroup) === 'project'],
    ['tipo desconocido → participants (falla hacia el caso más común)',
        fieldForType('lo-que-sea') === 'participants'],
    ['tipo ausente → participants (nunca undefined: el populate lo exige)',
        fieldForType() === 'participants'],
    ['los cuatro valores del enum son distintos entre sí',
        new Set(
            [
                ENUM_CONVERSATION_TYPE.oneToOne,
                ENUM_CONVERSATION_TYPE.chatGroup,
                ENUM_CONVERSATION_TYPE.bondLinkGroup,
                ENUM_CONVERSATION_TYPE.projectGroup,
            ].map(fieldForType)
        ).size === 4],
];

export const runEmitConversationSnapshotsTests = (): { pass: number; fail: number } => {
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
