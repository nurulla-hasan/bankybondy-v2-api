/* eslint-disable @typescript-eslint/no-explicit-any */
/* Pruebas puras de la interpretación de la moderación de imagen (sin llamar a
 * OpenAI). Blindan el criterio: flagged→unsafe, y fail-open ante resultado raro. */
import { interpretImageModeration } from './moderateImage';

type Case = [name: string, cond: boolean];

const v = (result: any) => interpretImageModeration(result);

const cases: Case[] = [
    ['no flagged → safe',
        v({ results: [{ flagged: false, categories: {} }] }).safe === true],
    ['flagged con categoría → unsafe + reason',
        v({ results: [{ flagged: true, categories: { sexual: true, violence: false } }] }).safe === false &&
        v({ results: [{ flagged: true, categories: { sexual: true, violence: false } }] }).reason === 'sexual'],
    ['flagged con varias categorías → reason con todas',
        v({ results: [{ flagged: true, categories: { sexual: true, 'violence/graphic': true, hate: false } }] }).reason ===
            'sexual, violence/graphic'],
    ['flagged sin categorías → reason "flagged"',
        v({ results: [{ flagged: true }] }).reason === 'flagged'],
    ['resultado ausente → safe (fail-open)', v(undefined).safe === true],
    ['results vacío → safe', v({ results: [] }).safe === true],
    ['flagged no-boolean → safe (fail-open)',
        v({ results: [{ flagged: 'yes' }] }).safe === true],
];

export const runImageModerationTests = (): { pass: number; fail: number } => {
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
