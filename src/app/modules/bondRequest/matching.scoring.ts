/* Funciones de puntaje PURAS del matcheo de bonds.
 * No tocan la base de datos ni el estado: reciben números y devuelven números,
 * lo que las hace fáciles de testear y ajustar. */
import { MATCHING } from './matching.config';

export const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Calidad semántica de un match, ponderando el eslabón más débil.
 *  s1 = coseno(miDeseo, suOferta); s2 = coseno(suDeseo, miOferta). */
export const semanticQuality = (
    s1: number,
    s2: number,
    wMin: number = MATCHING.wMin
): number => {
    const min = Math.min(s1, s2);
    const mean = (s1 + s2) / 2;
    return clamp01(wMin * min + (1 - wMin) * mean);
};

/** Alternativa parameter-free que castiga el desbalance por sí sola. */
export const harmonicMean = (s1: number, s2: number): number =>
    s1 + s2 === 0 ? 0 : clamp01((2 * s1 * s2) / (s1 + s2));

/** Un par califica solo si ambos sentidos pasan el umbral (gate duro). */
export const passesGate = (
    s1: number,
    s2: number,
    minScore: number = MATCHING.minScore
): boolean => s1 >= minScore && s2 >= minScore;

/** La calidad de un ciclo es su eslabón más débil (el cuello de botella). */
export const cycleQuality = (edgeScores: number[]): number =>
    edgeScores.length ? Math.min(...edgeScores) : 0;

/** Reputación bayesiana normalizada 0–1.
 *  Con pocas valoraciones tiende al prior neutro (ni perfecto ni pésimo). */
export const bayesianReputation = (
    avgStars: number,
    count: number,
    prior: number = MATCHING.reputation.prior,
    priorWeight: number = MATCHING.reputation.priorWeight
): number => {
    if (!count || count <= 0) return clamp01(prior); // cold start
    const observed = clamp01(avgStars / 5);
    return clamp01((priorWeight * prior + count * observed) / (priorWeight + count));
};

/** Factor de reputación de un match: el eslabón más débil entre los participantes.
 *  (Para un par, es la reputación de la contraparte.) */
export const reputationFactor = (participantScores: number[]): number =>
    participantScores.length
        ? Math.min(...participantScores)
        : clamp01(MATCHING.reputation.prior);

/** Cercanía: 1 = mismo lugar; 0 = en el borde del radio. Online/sin geo = 1. */
export const proximityFactor = (
    distanceKm?: number,
    radiusKm?: number
): number => {
    if (distanceKm == null || radiusKm == null || radiusKm <= 0) return 1;
    return clamp01(1 - distanceKm / radiusKm);
};

/** Frescura: decaimiento exponencial por antigüedad de la última actividad. */
export const freshnessFactor = (
    updatedAt?: Date | string,
    halfLifeDays: number = MATCHING.freshnessHalfLifeDays
): number => {
    if (!updatedAt) return 1;
    const days =
        (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (!Number.isFinite(days) || days < 0) return 1;
    return clamp01(Math.pow(0.5, days / halfLifeDays));
};

/** Puntaje de un borde con comodín "surprise" (simétrico deseo/oferta).
 *  Si el DESEO es surprise ("acepto cualquier oferta") O la OFERTA es surprise
 *  ("doy lo que busques"), el borde vale `floor + margin·sim`. Si no hay comodín,
 *  devuelve la similitud tal cual.
 *  - `floor` (default 0.6): el comodín es "aceptable" sin inflar el eslabón débil.
 *  - `floor + margin` (default 0.8): techo, para que un match genuino fuerte gane. */
/* Puntaje de un eslabón con comodín. Modelo de TRES niveles:
 *  - concreto ↔ concreto  → similitud real (sim).
 *  - comodín  ↔ CONCRETO  → piso + bonus. El comodín LLENA una necesidad
 *    concreta (se amolda a algo definido) → vale MÁS que dos comodines sueltos.
 *  - comodín  ↔ comodín   → solo el piso (doble sorpresa: nadie definió nada).
 * Así 'surprise' prefiere explícitamente un concreto por sobre otro surprise, y
 * un match concreto fuerte (sim alta) sigue ganándole a cualquier comodín.
 * NOTA: la similitud del token "surprise" contra otra cosa no tiene señal útil
 * (se parece solo a sí misma), por eso NO se usa `sim` en los casos comodín. */
export const surpriseAdjustedScore = (
    sim: number,
    wantIsSurprise: boolean,
    offerIsSurprise: boolean,
    floor: number = MATCHING.surpriseFloor,
    concreteBonus: number = MATCHING.surpriseMargin
): number => {
    if (!wantIsSurprise && !offerIsSurprise) return clamp01(sim);
    const bothSurprise = wantIsSurprise && offerIsSurprise;
    return clamp01(bothSurprise ? floor : floor + concreteBonus);
};

/** Puntaje de una arista "deseo ← oferta" que involucra el comodín 'vacío' (nada).
 *  Implementa la fila/columna "Vacío" de la tabla de la spec (Matcheo-Comodines-Spec):
 *   - vacío(deseo) ← vacío(oferta)                → `encounter` (ALTO): el encuentro.
 *   - vacío(deseo) ← sorpresa  /  sorpresa(deseo) ← vacío → `mixed` (sólido, pero
 *     por debajo del encuentro: debe superar `minScore` con margen).
 *   - vacío(deseo) ← concreto  /  concreto(deseo) ← vacío → 0 (EXCLUIDO).
 *  A 'vacío' no le sirve la similitud del vector (no tiene señal semántica: se
 *  parece solo a sí mismo), por eso se resuelve SOLO por banda. Llamar únicamente
 *  cuando hay 'vacío' en al menos un lado. */
export const emptyEdgeScore = (
    wantIsEmpty: boolean,
    wantIsSurprise: boolean,
    offerIsEmpty: boolean,
    offerIsSurprise: boolean,
    encounter: number = MATCHING.emptyEncounter,
    mixed: number = MATCHING.emptyMixed
): number => {
    if (wantIsEmpty && offerIsEmpty) return clamp01(encounter); // encuentro
    if (wantIsEmpty) return offerIsSurprise ? clamp01(mixed) : 0; // deseo vacío ← sorpresa/concreto
    // offerIsEmpty && !wantIsEmpty: oferta vacía → deseo NO vacío.
    return wantIsSurprise ? clamp01(mixed) : 0; // sorpresa quiere algo=mixed; concreto=excluido
};

/** Factor de modalidad: preferencia SUAVE (no filtro).
 *  - Mismo formato → 1 (sin penalización).
 *  - Formato ausente en cualquiera de los dos (datos legado / bond sin modalidad)
 *    → 1 (tolerante: no penaliza ni excluye).
 *  - Ambos formatos explícitos y DISTINTOS → `mismatch` (< 1, baja el score).
 *  Con `cross = false` (filtro duro por env) siempre devuelve 1: en ese modo los
 *  cross-formato ni siquiera llegan a puntuarse (se filtran en la recuperación). */
export const modalityFactor = (
    a: string | undefined,
    b: string | undefined,
    mismatch: number = MATCHING.modalityMismatchFactor,
    cross: boolean = MATCHING.crossModality
): number => {
    if (!cross) return 1;
    if (!a || !b) return 1;
    return a === b ? 1 : clamp01(mismatch);
};

export interface MatchScoreParts {
    semQuality: number;
    reputation: number;
    proximity: number;
    freshness: number;
}

/** Puntaje final compuesto (0–1) con pesos ajustables. */
export const finalMatchScore = (
    parts: MatchScoreParts,
    weights = MATCHING.weights
): number =>
    clamp01(
        weights.sem * parts.semQuality +
            weights.rep * parts.reputation +
            weights.prox * parts.proximity +
            weights.fresh * parts.freshness
    );
