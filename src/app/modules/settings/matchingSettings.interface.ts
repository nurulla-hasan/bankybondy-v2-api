export interface MatchingSettingsValues {
    candidateMode: 'vector' | 'knn';
    frontierEnabled: boolean;
    cacheTtlMinutes: number;
    surpriseFloor: number;
    surpriseMargin: number;
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
