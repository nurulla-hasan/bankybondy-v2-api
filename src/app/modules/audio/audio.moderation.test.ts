/* eslint-disable @typescript-eslint/no-explicit-any */
/* Pruebas puras de qué textos de audio se moderan. Blindan que no se olvide
 * ningún campo público (título/descripción/tags) y que entradas raras no rompan. */
import { collectAudioTexts } from './audio.moderation';

const labels = (p: any): string =>
    collectAudioTexts(p)
        .map((t) => t.label)
        .join(',');
const texts = (p: any): string =>
    collectAudioTexts(p)
        .map((t) => t.text)
        .join('|');

type Case = [name: string, cond: boolean];

const cases: Case[] = [
    ['título+descripción+2 tags → 4 textos con labels correctos',
        labels({ title: 't', description: 'd', tags: ['a', 'b'] }) ===
            'Title,Description,Tag 1,Tag 2'],
    ['descripción ausente → se saltea',
        labels({ title: 't', tags: ['a'] }) === 'Title,Tag 1'],
    ['título solo espacios → se saltea',
        labels({ title: '   ', description: 'd' }) === 'Description'],
    ['sin tags → solo título/descripción',
        labels({ title: 't', description: 'd' }) === 'Title,Description'],
    ['tags no-array → no rompe (sin tags)',
        labels({ title: 't', tags: 'no-array' }) === 'Title'],
    ['tag no-string o vacío se saltea, sin correr la numeración',
        labels({ title: 't', tags: ['ok', 123, '', 'ok2'] }) === 'Title,Tag 1,Tag 4'],
    ['payload vacío → []', collectAudioTexts({}).length === 0],
    ['null/undefined → [] sin throw',
        collectAudioTexts(null).length === 0 &&
            collectAudioTexts(undefined).length === 0],
    ['conserva el texto original (no lo altera)',
        texts({ title: 'Hola', description: 'Mundo' }) === 'Hola|Mundo'],
];

export const runAudioModerationTests = (): { pass: number; fail: number } => {
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
