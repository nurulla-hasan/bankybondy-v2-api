/* Prueba pura del normalizador de texto (sin DB ni red).
 * Blindan la propiedad que importa: lo que llega por el socket SIEMPRE sale como
 * string, porque `getMessages` filtra por `text: {$regex: ''}` y ese filtro deja
 * fuera cualquier valor que no sea string (mensaje guardado e invisible). */
import { normalizeMessageText } from './normalizeMessageText';

type Case = [name: string, cond: boolean];

const cases: Case[] = [
    // — lo que el cliente manda hoy —
    ['string normal pasa igual', normalizeMessageText('hola') === 'hola'],
    ['string vacio pasa igual', normalizeMessageText('') === ''],
    ['no se recorta: los espacios del usuario son contenido',
        normalizeMessageText('  hola  ') === '  hola  '],
    ['unicode/emoji intacto', normalizeMessageText('¿Cómo estás? 🙂') === '¿Cómo estás? 🙂'],

    // — lo que antes desaparecia del historial —
    ['null -> string vacio (no null)', normalizeMessageText(null) === ''],
    ['undefined -> string vacio', normalizeMessageText(undefined) === ''],
    ['numero -> string vacio (no "123" ni numero)', normalizeMessageText(123) === ''],
    ['objeto -> string vacio (no "[object Object]")',
        normalizeMessageText({ hola: 1 }) === ''],
    ['array -> string vacio', normalizeMessageText(['hola']) === ''],
    ['booleano -> string vacio', normalizeMessageText(true) === ''],
    ['payload sin campo text -> string vacio',
        normalizeMessageText(({} as { text?: unknown }).text) === ''],

    // Un `String(text)` como fallback pasaría este filtro y llenaría el historial
    // de "[object Object]": la normalización tiene que ir al string VACÍO.
    ['la salida siempre es string y toda entrada no-string sale vacia',
        [null, undefined, 1, true, {}, [], ['hola']].every(
            (v) => normalizeMessageText(v) === ''
        ) && typeof normalizeMessageText('hola') === 'string'],
];

export const runNormalizeMessageTextTests = (): { pass: number; fail: number } => {
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
