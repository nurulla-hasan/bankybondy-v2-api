/* Pruebas puras del score de trending (E1). Blindan la forma del ranking:
 * más escuchas/completion/guardados suben; la edad baja; las señales costosas
 * pesan; y entradas basura no rompen. */
import {
    computeTrendingScore,
    TRENDING_BOOKMARK_WEIGHT,
} from './audio.trending';

const s = computeTrendingScore;

type Case = [name: string, cond: boolean];

const cases: Case[] = [
    // Monotonía en cada señal (a igualdad del resto)
    ['más escuchas → más score',
        s({ listens: 100, avgCompletion: 0.8, ageHours: 10 }) >
            s({ listens: 50, avgCompletion: 0.8, ageHours: 10 })],
    ['más completion → más score',
        s({ listens: 100, avgCompletion: 0.9, ageHours: 10 }) >
            s({ listens: 100, avgCompletion: 0.3, ageHours: 10 })],
    ['más guardados → más score',
        s({ listens: 100, avgCompletion: 0.8, bookmarks: 20, ageHours: 10 }) >
            s({ listens: 100, avgCompletion: 0.8, bookmarks: 0, ageHours: 10 })],
    ['más viejo → menos score',
        s({ listens: 100, avgCompletion: 0.8, ageHours: 240 }) <
            s({ listens: 100, avgCompletion: 0.8, ageHours: 1 })],

    // Honestidad: completion pondera de verdad
    ['muchos plays a medias pierden contra menos plays enteros',
        s({ listens: 200, avgCompletion: 0.2, ageHours: 10 }) <
            s({ listens: 60, avgCompletion: 0.95, ageHours: 10 })],

    // Señal costosa: un guardado vale ~PESO escuchas completas
    ['un guardado pesa como ~PESO_GUARDADO escuchas completas',
        Math.abs(
            s({ bookmarks: 1, ageHours: 10 }) -
                s({ listens: TRENDING_BOOKMARK_WEIGHT, avgCompletion: 1, ageHours: 10 })
        ) < 1e-9],

    // Ceros y basura
    ['sin engagement → 0', s({ listens: 0, bookmarks: 0, ageHours: 5 }) === 0],
    ['listens negativos → tratados como 0',
        s({ listens: -100, avgCompletion: 1, ageHours: 5 }) === 0],
    ['completion > 1 se clampa a 1',
        s({ listens: 10, avgCompletion: 9, ageHours: 10 }) ===
            s({ listens: 10, avgCompletion: 1, ageHours: 10 })],
    ['no-numérico → no rompe (score 0)',
        s({ listens: 'x' as any, avgCompletion: null as any, ageHours: 'y' as any }) === 0],
    ['score siempre finito y >= 0',
        Number.isFinite(s({ listens: 1e6, avgCompletion: 1, bookmarks: 1e6, ageHours: 0 })) &&
            s({ listens: 1e6, avgCompletion: 1, bookmarks: 1e6, ageHours: 0 }) >= 0],
];

export const runTrendingTests = (): { pass: number; fail: number } => {
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
