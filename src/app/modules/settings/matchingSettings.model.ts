import { model, Schema } from 'mongoose';
import { isValidMatchingSweepCron } from './matchingSettings.validation';
import { MatchingSettingsValues } from './matchingSettings.interface';

export const MATCHING_SETTINGS_ID = 'matching';

export interface MatchingSettingsRecord extends MatchingSettingsValues {
    _id: string;
    revision: number;
    computeRevision: number;
    updatedBy: string | null;
    createdAt: Date;
    updatedAt: Date;
}

const integer = (min: number, max: number) => ({
    type: Number, required: true, min, max,
    validate: { validator: Number.isInteger, message: 'Must be an integer' },
});

const schema = new Schema<MatchingSettingsRecord>({
    _id: { type: String, required: true, default: MATCHING_SETTINGS_ID, enum: [MATCHING_SETTINGS_ID], immutable: true },
    candidateMode: { type: String, required: true, enum: ['vector', 'knn'] },
    frontierEnabled: { type: Boolean, required: true },
    cacheTtlMinutes: integer(0, 43200),
    surpriseFloor: { type: Number, required: true, min: 0, max: 1 },
    surpriseMargin: { type: Number, required: true, min: 0, max: 1 },
    frontierSeeds: integer(1, 20),
    sweepEnabled: { type: Boolean, required: true },
    sweepBatch: integer(1, 20000),
    sweepCron: { type: String, required: true, trim: true, maxlength: 120, validate: { validator: isValidMatchingSweepCron, message: 'Invalid cron expression' } },
    revision: { ...integer(0, Number.MAX_SAFE_INTEGER), default: 0 },
    // Revision zero also represents legacy matching results with no revision field.
    computeRevision: { ...integer(0, Number.MAX_SAFE_INTEGER), default: 0 },
    updatedBy: { type: String, default: null },
}, { timestamps: true, versionKey: false, strict: 'throw' });

export const MatchingSettings = model<MatchingSettingsRecord>('MatchingSettings', schema);
