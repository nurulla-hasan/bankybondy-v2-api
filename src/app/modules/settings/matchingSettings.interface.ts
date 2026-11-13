export interface MatchingSettingsValues {
    candidateMode: 'vector' | 'knn';
    frontierEnabled: boolean;
    cacheTtlMinutes: number;
    surpriseFloor: number;
    surpriseMargin: number;
    emptyEncounter: number;
    emptyMixed: number;
    minScore: number;
    minServeScore: number;
    wMin: number;
    weightSem: number;
    weightRep: number;
    weightProx: number;
    weightFresh: number;
    pairBias: number;
    maxResults: number;
    frontierSeeds: number;
    sweepEnabled: boolean;
    sweepBatch: number;
    sweepCron: string;
}

export interface MatchingSettingsSnapshot extends MatchingSettingsValues {
    revision: number;
    computeRevision: number;
    updatedAt: string;
    updatedBy: string | null;
}
