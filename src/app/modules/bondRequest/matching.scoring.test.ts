/* Test de las funciones de puntaje del matcheo (pruebas puras, sin DB).
 * Se puede correr con vitest/jest cuando se configure un runner, o con:
 *   node --experimental-strip-types matching.scoring.test.ts
 * (ajustando los imports con extensión .ts). */
import * as s from './matching.scoring';
import { MATCHING } from './matching.config';
import { specialEntryColor, SPECIAL_COLORS } from './matching.colors';

type Case = [name: string, cond: boolean];

const cases: Case[] = [
    // Eslabón más débil: balanceado gana a desparejo con mismo promedio.
    ['balanceado(0.7,0.7) > desparejo(0.99,0.41)',
        s.semanticQuality(0.7, 0.7) > s.semanticQuality(0.99, 0.41)],
    ['semQuality balanceado ~0.7', Math.abs(s.semanticQuality(0.7, 0.7) - 0.7) < 1e-9],
    // Gate duro.
    ['gate 0.5/0.5 pasa', s.passesGate(0.5, 0.5) === true],
    ['gate 0.9/0.3 NO pasa', s.passesGate(0.9, 0.3) === false],
    // Ciclo = eslabón más débil.
    ['cycleQuality = min', s.cycleQuality([0.8, 0.5, 0.9]) === 0.5],
    // Reputación bayesiana.
    ['rep cold-start = prior 0.6', Math.abs(s.bayesianReputation(0, 0) - 0.6) < 1e-9],
    ['rep pocos votos < muchos', s.bayesianReputation(5, 1) < s.bayesianReputation(5, 100)],
    ['rep muchos 5★ > 0.95', s.bayesianReputation(5, 100) > 0.95],
    // Proximidad.
    ['prox online/sin geo = 1', s.proximityFactor() === 1],
    ['prox borde = 0', s.proximityFactor(10, 10) === 0],
    ['prox mitad = 0.5', Math.abs(s.proximityFactor(5, 10) - 0.5) < 1e-9],
    // Frescura.
    ['fresco ahora ~1', Math.abs(s.freshnessFactor(new Date()) - 1) < 1e-3],
    // Puntaje final.
    ['finalScore en [0,1]',
        (() => { const f = s.finalMatchScore({ semQuality: 0.7, reputation: 0.5, proximity: 0.8, freshness: 0.9 }); return f >= 0 && f <= 1; })()],
    ['mejor reputación sube el score',
        s.finalMatchScore({ semQuality: 0.7, reputation: 0.9, proximity: 0.8, freshness: 0.9 }) >
        s.finalMatchScore({ semQuality: 0.7, reputation: 0.5, proximity: 0.8, freshness: 0.9 })],
    // Modalidad (preferencia suave): mismo=1, distinto=penaliza, ausente=1 (tolerante).
    ['modalidad misma = 1', s.modalityFactor('physical', 'physical', 0.85, true) === 1],
    ['modalidad online=online = 1', s.modalityFactor('online', 'online', 0.85, true) === 1],
    ['modalidad distinta penaliza', s.modalityFactor('physical', 'online', 0.85, true) === 0.85],
    ['modalidad ausente (uno) = 1', s.modalityFactor(undefined, 'online', 0.85, true) === 1],
    ['modalidad ausente (ambos) = 1', s.modalityFactor(undefined, undefined, 0.85, true) === 1],
    ['cross=false no penaliza (filtro duro aparte)', s.modalityFactor('physical', 'online', 0.85, false) === 1],
    ['modalidad distinta baja el finalScore',
        s.finalMatchScore({ semQuality: 0.7, reputation: 0.5, proximity: 0.8, freshness: 0.9 }) * s.modalityFactor('physical', 'online', 0.85, true) <
        s.finalMatchScore({ semQuality: 0.7, reputation: 0.5, proximity: 0.8, freshness: 0.9 })],
    // Comodín surprise: TRES niveles. surprise↔concreto (piso+bonus) > surprise↔surprise (piso).
    ['surprise↔concreto en Pido (want) = piso+bonus (0.55)', Math.abs(s.surpriseAdjustedScore(0.1, true, false, 0.45, 0.1) - 0.55) < 1e-9],
    ['surprise↔concreto en Ofrezco (offer) = piso+bonus (0.55)', Math.abs(s.surpriseAdjustedScore(0.1, false, true, 0.45, 0.1) - 0.55) < 1e-9],
    ['surprise↔surprise (ambos) = solo piso (0.45)', Math.abs(s.surpriseAdjustedScore(1.0, true, true, 0.45, 0.1) - 0.45) < 1e-9],
    ['surprise PREFIERE concreto sobre surprise',
        s.surpriseAdjustedScore(0, true, false, 0.45, 0.1) > s.surpriseAdjustedScore(1.0, true, true, 0.45, 0.1)],
    ['sin comodín = similitud real', s.surpriseAdjustedScore(0.9, false, false, 0.45, 0.1) === 0.9],
    ['match concreto fuerte (0.9) le gana al comodín-concreto (0.55)',
        s.surpriseAdjustedScore(0.9, false, false, 0.45, 0.1) > s.surpriseAdjustedScore(0, true, false, 0.45, 0.1)],
    ['ambos casos comodín pasan el gate (>=0.4)',
        s.surpriseAdjustedScore(0, true, true, 0.45, 0.1) >= 0.4 && s.surpriseAdjustedScore(0, true, false, 0.45, 0.1) >= 0.4],
    // Comodín EMPTY (vacío = nada). Tabla de aristas de Matcheo-Comodines-Spec §4.
    // Firma: emptyEdgeScore(wantEmpty, wantSurprise, offerEmpty, offerSurprise, encounter=0.9, mixed=0.4).
    ['vacío(deseo)↔vacío(oferta) = encuentro (alto 0.9)',
        Math.abs(s.emptyEdgeScore(true, false, true, false, 0.9, 0.4) - 0.9) < 1e-9],
    ['deseo vacío ← oferta sorpresa = mixed (0.4)',
        Math.abs(s.emptyEdgeScore(true, false, false, true, 0.9, 0.4) - 0.4) < 1e-9],
    ['deseo sorpresa ← oferta vacío = mixed (0.4)',
        Math.abs(s.emptyEdgeScore(false, true, true, false, 0.9, 0.4) - 0.4) < 1e-9],
    ['deseo vacío ← oferta concreta = 0 (excluido)',
        s.emptyEdgeScore(true, false, false, false, 0.9, 0.4) === 0],
    ['deseo concreto ← oferta vacío = 0 (excluido)',
        s.emptyEdgeScore(false, false, true, false, 0.9, 0.4) === 0],
    ['encuentro (vacío↔vacío) le gana a lo mixto (vacío↔sorpresa)',
        s.emptyEdgeScore(true, false, true, false, 0.9, 0.4) > s.emptyEdgeScore(false, true, true, false, 0.9, 0.4)],
    ['vacío↔concreto NO pasa el gate (arista 0 → excluido)',
        s.passesGate(s.emptyEdgeScore(false, false, true, false, 0.9, 0.4), 0.9) === false],
    // Config REAL: vacío↔sorpresa debe superar el gate con MARGEN (no quedar justo
    // en 0.4, donde cualquier suba de MATCH_MIN_SCORE lo hacía desaparecer) y
    // seguir por debajo del encuentro vacío↔vacío.
    ['default: vacío↔sorpresa supera el gate con margen',
        s.emptyEdgeScore(true, false, false, true) > MATCHING.minScore],
    ['default: vacío↔sorpresa < vacío↔vacío',
        s.emptyEdgeScore(true, false, false, true) < s.emptyEdgeScore(true, false, true, false)],
    // Robustez geo/frescura: entradas ausentes NO rompen (devuelven neutro, sin throw).
    ['prox sin datos = 1 (no throw)', s.proximityFactor(undefined, undefined) === 1],
    ['frescura sin fecha = 1 (no throw)', s.freshnessFactor(undefined) === 1],
    // Color de caja (specialEntryColor(own, counterpart)). REGLA POR-PAR: las dos
    // puntas del mismo par devuelven el MISMO color. El vacío solo matchea con
    // vacío o con sorpresa (nunca concreto).
    ['vacío↔sorpresa = violeta (own empty)',
        specialEntryColor('empty', 'surprise') === SPECIAL_COLORS.emptySurprise],
    ['vacío↔sorpresa = violeta (own surprise) — simétrico',
        specialEntryColor('surprise', 'empty') === SPECIAL_COLORS.emptySurprise],
    ['vacío↔sorpresa: MISMO color en las dos puntas',
        specialEntryColor('empty', 'surprise') === specialEntryColor('surprise', 'empty')],
    ['vacío↔vacío = coral (ambos regalo)',
        specialEntryColor('empty', 'empty') === SPECIAL_COLORS.empty],
    ['sorpresa↔sorpresa = fucsia',
        specialEntryColor('surprise', 'surprise') === SPECIAL_COLORS.surprise],
    ['sorpresa↔concreto = pastel (null, no se alarma)',
        specialEntryColor('surprise', 'Guitarra') === null],
    ['concreto↔sorpresa = pastel (null)', specialEntryColor('Guitarra', 'surprise') === null],
    ['concreto↔concreto = pastel (null)', specialEntryColor('Guitarra', 'Piano') === null],
    ['vacío defensivo vs concreto (no ocurre en matches) = coral, no rompe',
        specialEntryColor('empty', 'Guitarra') === SPECIAL_COLORS.empty],
    ['surprise propio, contraparte ausente = pastel (null)', specialEntryColor('surprise', undefined) === null],
    ['ambos ausentes = pastel (null)', specialEntryColor(undefined, undefined) === null],
];

export const runMatchingScoreTests = (): { pass: number; fail: number } => {
    let pass = 0, fail = 0;
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
