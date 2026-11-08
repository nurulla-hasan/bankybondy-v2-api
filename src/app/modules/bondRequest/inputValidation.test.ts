/* eslint-disable @typescript-eslint/no-explicit-any */
/* Pruebas puras de los schemas de validación (zod, sin DB).
 * Blindan: rating entero (no decimal) y offer/want no vacíos (evita el 500 por
 * embedding de string vacío). */
import { addRatingValidation } from '../bondRating/bondRating.validation';
import bondRequestValidation from './bondRequest.validation';

const rate = (rating: any): boolean =>
    addRatingValidation.safeParse({ body: { userId: 'u', bondLink: 'b', rating } })
        .success;
const create = (offer: any, want: any): boolean =>
    bondRequestValidation.createBondRequestValidationSchema.safeParse({
        body: { offer, want },
    }).success;
const update = (body: any): boolean =>
    bondRequestValidation.updateBondRequestValidationSchema.safeParse({ body })
        .success;

type Case = [name: string, cond: boolean];

const cases: Case[] = [
    // rating entero 1..5
    ['rating decimal (4.5) → rechazado', rate(4.5) === false],
    ['rating entero (4) → ok', rate(4) === true],
    ['rating > max (6) → rechazado', rate(6) === false],
    ['rating < min (0) → rechazado', rate(0) === false],

    // offer/want no vacíos en create
    ['create offer vacío → rechazado (400, no 500)', create('', 'Piano') === false],
    ['create want vacío → rechazado', create('Guitarra', '') === false],
    ['create offer solo espacios → rechazado (trim)', create('   ', 'Piano') === false],
    ['create offer/want válidos → ok', create('Guitarra', 'Piano') === true],

    // update: opcionales, pero si vienen no pueden ser vacíos
    ['update offer vacío → rechazado', update({ offer: '' }) === false],
    ['update sin offer/want → ok (opcionales)', update({}) === true],
    ['pause true is accepted', update({ isPause: true }) === true],
    ['pause false is accepted', update({ isPause: false }) === true],
    ...[null, 'false', 0, [], {}].map((isPause): Case => [
        `non-boolean pause ${JSON.stringify(isPause)} is rejected`,
        update({ isPause }) === false,
    ]),
];

export const runInputValidationTests = (): { pass: number; fail: number } => {
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
