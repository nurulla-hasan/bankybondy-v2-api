/* Pruebas puras del clamp de paginación. Blindan que ningún `?limit` gigante o
 * `?page` raro pase sin acotar (DoS / metadata rota). */
import { clampLimit, clampPage } from './pagination';

type Case = [name: string, cond: boolean];

const cases: Case[] = [
    // clampLimit
    ['limit gigante → tope 500', clampLimit(9999999) === 500],
    ['limit normal se respeta', clampLimit('50') === 50],
    ['limit negativo → 1', clampLimit(-5) === 1],
    ['limit no-numérico → fallback 10', clampLimit('abc') === 10],
    ['limit ausente → fallback 10', clampLimit(undefined) === 10],
    ['limit 0 → fallback 10', clampLimit(0) === 10],
    ['limit decimal → piso entero', clampLimit(2.9) === 2],
    ['max custom se respeta', clampLimit(200, 10, 100) === 100],
    ['fallback custom se respeta', clampLimit(undefined, 20) === 20],

    // clampPage
    ['page gigante NO se capea (skip alto es válido)', clampPage(1000000) === 1000000],
    ['page negativa → 1', clampPage(-3) === 1],
    ['page no-numérica → 1', clampPage('abc') === 1],
    ['page decimal → piso entero', clampPage(2.9) === 2],
    ['page ausente → 1', clampPage(undefined) === 1],
    // Infinito: `Number('1e999')` es Infinity y la versión anterior lo dejaba
    // pasar → `$skip: Infinity` → Mongo lo rechaza → 500. El clamp de `page` NO
    // servía justo para el input que más fácil rompe.
    ['page Infinity (1e999) → 1', clampPage('1e999') === 1],
    ['page -Infinity → 1', clampPage(-Infinity) === 1],
    ['page NaN → 1', clampPage(NaN) === 1],
    ['page string vacío → 1', clampPage('') === 1],
    // clampLimit ya estaba a salvo del infinito por su `Math.min(max)`: se blinda
    // para que nadie lo rompa al refactorizar.
    ['limit Infinity → tope 500', clampLimit('1e999') === 500],
    // Express entrega un ARRAY cuando la query repite la clave (`?page=1&page=2`).
    // Hoy se comportan bien por accidente (`Number(['1','2'])` es NaN), pero sin
    // test nadie lo blinda: es el mismo input que rompía el sort/fields del
    // QueryBuilder con un TypeError.
    ['page como ARRAY → 1', clampPage(['1', '2']) === 1],
    ['limit como ARRAY → fallback', clampLimit(['1', '2']) === 10],
    ['page null → 1', clampPage(null) === 1],
    ['limit -Infinity → 1', clampLimit(-Infinity) === 1],
];

export const runPaginationTests = (): { pass: number; fail: number } => {
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
