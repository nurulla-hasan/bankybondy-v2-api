/* Pruebas puras del read model (sin DB): firma de match, fan-out por participante
 * y ranking compartido. La persistencia real se cubre con
 * src/scripts/verifyMatchFeed.ts contra Mongo. */
import { recordToFeedDocs, buildMatchKey, rankScoreOf, topMatchKeys } from './matching.feed';
import type { MatchRecord } from './matching.compute';
import { MATCHING } from './matching.config';

type Case = [name: string, cond: boolean];

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const U1 = '111111111111111111111111';
const U2 = '222222222222222222222222';

const record: MatchRecord = {
    ids: [B, A],
    users: [U2, U1],
    score: 0.8,
    parts: { sem: 0.7, rep: 0.6, prox: 1, fresh: 1 },
    type: 'entry',
    size: 2,
};

const docs = recordToFeedDocs(record, A, new Date(0));
const dupDocs = recordToFeedDocs(
    {
        ...record,
        ids: [A, A, B],
        users: [U1, U1, U2],
    },
    A,
    new Date(0)
);

const cases: Case[] = [
    ['firma: orden de ids no importa', buildMatchKey([A, B]) === buildMatchKey([B, A])],
    ['firma: formato estable', buildMatchKey([B, A]) === `${A}|${B}`],
    ['firma: un solo id', buildMatchKey([A]) === A],
    ['fan-out: una fila por participante', docs.length === 2],
    ['fan-out: mismo matchKey en todas las filas', docs.every((d) => d.matchKey === `${A}|${B}`)],
    ['fan-out: cada fila pertenece a un participante', docs.map((d) => d.bond.toString()).sort().join(',') === `${A},${B}`],
    ['fan-out: bonds completo en cada fila', docs.every((d) => d.bonds.length === 2)],
    ['fan-out: sourceBond es el discoverer', docs.every((d) => d.sourceBond.toString() === A)],
    ['fan-out: ids duplicados no duplican filas', dupDocs.length === 2],
    ['fan-out: array vacío no produce filas', recordToFeedDocs({ ...record, ids: [], users: [] }, A).length === 0],
    ['ranking: par sin castigo', rankScoreOf(0.8, 2, false) === 0.8],
    ['ranking: ciclo descuenta pairBias', Math.abs(rankScoreOf(0.8, 3, false) - (0.8 - 0.05)) < 1e-9],
    ['ranking: legacy no descuenta', rankScoreOf(0.8, 4, true) === 0.8],
    ['top keys: ordena por score desc', topMatchKeys([{ matchKey: 'x', score: 0.1 }, { matchKey: 'y', score: 0.9 }], 1)[0] === 'y'],
    ['top keys: deriva la firma si falta matchKey', topMatchKeys([{ bonds: [B, A], score: 0.9 }], 1)[0] === `${A}|${B}`],
    // La poda no puede cortar por debajo de lo que el serving lee: si
    // min(cap, scan) queda chico, un bond denso se sirve topeado en silencio.
    ['poda: ventana >= 2x maxResults (min(cap, scan))', Math.min(MATCHING.feedMaxRowsPerBond, MATCHING.feedScanLimit) >= 2 * MATCHING.maxResults],
    ['poda: cap cubre el scan completo', MATCHING.feedMaxRowsPerBond >= MATCHING.feedScanLimit],
];

export const runMatchingFeedTests = (): { pass: number; fail: number } => {
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