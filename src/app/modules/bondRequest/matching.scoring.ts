/* Pure bond-matching scoring: no DB or state touched — numbers in, numbers out,
 * which keeps it easy to test and tune. */
import { MATCHING } from './matching.config';

export const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Semantic match quality, weighting the weakest link.
 *  s1 = cos(myWant, theirOffer); s2 = cos(theirWant, myOffer). */
export const semanticQuality = (
    s1: number,
    s2: number,
    wMin: number = MATCHING.wMin
): number => {
    const min = Math.min(s1, s2);
    const mean = (s1 + s2) / 2;
    return clamp01(wMin * min + (1 - wMin) * mean);
};

/** Parameter-free alternative that penalizes imbalance on its own. */
export const harmonicMean = (s1: number, s2: number): number =>
    s1 + s2 === 0 ? 0 : clamp01((2 * s1 * s2) / (s1 + s2));

/** Hard gate: both directions must be >= minScore (inclusive). */
export const passesGate = (
    s1: number,
    s2: number,
    minScore: number = MATCHING.minScore
): boolean => s1 >= minScore && s2 >= minScore;

/** A cycle's quality is its weakest link (the bottleneck). */
export const cycleQuality = (edgeScores: number[]): number =>
    edgeScores.length ? Math.min(...edgeScores) : 0;

/** Bayesian reputation normalized 0–1: with few ratings it leans to the neutral
 *  prior (neither perfect nor terrible). */
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

/** Match reputation factor: the weakest link among participants (for a pair,
 *  the counterpart's reputation). */
export const reputationFactor = (participantScores: number[]): number =>
    participantScores.length
        ? Math.min(...participantScores)
        : clamp01(MATCHING.reputation.prior);

/** Proximity: 1 = same place, 0 = at the radius edge. Online/no geo = 1. */
export const proximityFactor = (
    distanceKm?: number,
    radiusKm?: number
): number => {
    if (distanceKm == null || radiusKm == null || radiusKm <= 0) return 1;
    return clamp01(1 - distanceKm / radiusKm);
};

/** Freshness: exponential decay by age of last activity. */
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

/** Wildcard "surprise" link score. Bands: concrete↔concrete → sim; wildcard↔
 *  concrete → floor + concreteBonus (fills a concrete need, worth more);
 *  wildcard↔wildcard → floor only. `sim` is unused for wildcards.
 *  Defaults: floor 0.6, ceiling (floor + margin) 0.8. */
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

/** Edge score for the 'vacío' (nothing) wildcard, resolved by band only (its
 *  vector has no semantic signal). Bands: empty↔empty → encounter (high);
 *  empty↔surprise → mixed (solid, must clear minScore); empty↔concrete → 0.
 *  Call only when at least one side is empty. */
export const emptyEdgeScore = (
    wantIsEmpty: boolean,
    wantIsSurprise: boolean,
    offerIsEmpty: boolean,
    offerIsSurprise: boolean,
    encounter: number = MATCHING.emptyEncounter,
    mixed: number = MATCHING.emptyMixed
): number => {
    if (wantIsEmpty && offerIsEmpty) return clamp01(encounter); // the encounter
    if (wantIsEmpty) return offerIsSurprise ? clamp01(mixed) : 0; // empty want ← surprise/concrete
    // Offer empty, want not empty.
    return wantIsSurprise ? clamp01(mixed) : 0; // surprise want = mixed; concrete = excluded
};

/** Modality factor: a SOFT preference, not a filter. Same format → 1; missing
 *  format on either side (legacy data) → 1 (tolerant); two explicit, different
 *  formats → `mismatch` (< 1). With `cross = false` (hard env filter) always 1,
 *  since cross-format pairs never reach scoring. */
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

/** Final composite score (0–1) with adjustable weights. */
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
