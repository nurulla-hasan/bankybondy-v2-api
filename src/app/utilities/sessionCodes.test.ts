/* Test de la lista de códigos de sesión muerta (pura, sin DB).
 *
 * El caso que MÁS importa está al final: que los códigos de negocio vivos NO
 * estén en el set. Un falso positivo acá no rompe una pantalla — echa al usuario
 * de su cuenta. Este test es el que blinda contra "agrego un código nuevo y sin
 * querer desloguea a todo el mundo".
 */
import {
    SESSION_DEAD_CODES,
    esCodigoDeSesionMuerta,
} from './sessionCodes';

type Case = [name: string, cond: boolean];

const cases: Case[] = [
    // --- los 6 que SÍ tienen que deslogear ---
    ...SESSION_DEAD_CODES.map(
        (c): Case => [`"${c}" desloguea`, esCodigoDeSesionMuerta(c) === true]
    ),
    ['son exactamente 6', SESSION_DEAD_CODES.length === 6],

    // --- LO MÁS IMPORTANTE: códigos de NEGOCIO vivos que NO deben deslogear ---
    // Existen y viajan en respuestas reales. Si alguno entrara al set, al usuario
    // lo echarían de su cuenta por llegar al tope de vínculos o por abrir un
    // perfil oculto.
    [
        'BOND_LIMIT_REACHED NO desloguea (es un tope de plan, no una sesión rota)',
        esCodigoDeSesionMuerta('BOND_LIMIT_REACHED') === false,
    ],
    [
        'PROFILE_HIDDEN NO desloguea (es privacidad de OTRO usuario)',
        esCodigoDeSesionMuerta('PROFILE_HIDDEN') === false,
    ],

    // --- basura: nada que no sea un string exacto puede echar a nadie ---
    ['undefined NO desloguea', esCodigoDeSesionMuerta(undefined) === false],
    ['null NO desloguea', esCodigoDeSesionMuerta(null) === false],
    ['string vacío NO desloguea', esCodigoDeSesionMuerta('') === false],
    [
        'un ARRAY con un código válido NO desloguea (el String() aplanaría: ver objectId.test)',
        esCodigoDeSesionMuerta(['ACCOUNT_BLOCKED']) === false,
    ],
    ['un objeto NO desloguea', esCodigoDeSesionMuerta({}) === false],
    [
        'minúsculas NO desloguean (la comparación es exacta)',
        esCodigoDeSesionMuerta('account_blocked') === false,
    ],
    [
        'con espacios NO desloguea',
        esCodigoDeSesionMuerta(' ACCOUNT_BLOCKED ') === false,
    ],
    [
        'un código inventado NO desloguea',
        esCodigoDeSesionMuerta('SOMETHING_ELSE') === false,
    ],
];

export const runSessionCodesTests = (): { pass: number; fail: number } => {
    let pass = 0;
    let fail = 0;
    for (const [name, cond] of cases) {
        if (cond) {
            pass++;
        } else {
            fail++;
            // eslint-disable-next-line no-console
            console.error(`  FALLO: ${name}`);
        }
    }
    return { pass, fail };
};

export default runSessionCodesTests;
