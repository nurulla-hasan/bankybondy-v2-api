import { z } from 'zod';
import cron from 'node-cron';

// node-cron v3 expands ranges before validating bounds. A short expression such
// as "0-999999999 * * * *" can otherwise block the process during validation.
const cronAtom = '(?:\\d+|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)';
const cronPart = new RegExp(`^(?:\\*|${cronAtom}(?:-${cronAtom})?)(?:/\\d+)?$`, 'i');

export function isValidMatchingSweepCron(value: string): boolean {
    if (value.length > 120) return false;
    const fields = value.trim().split(/\s+/);
    if (fields.length !== 5 && fields.length !== 6) return false;
    for (const field of fields) {
        for (const part of field.split(',')) {
            if (!cronPart.test(part)) return false;
            // Steps do not expand ranges; only endpoints need this safety guard.
            const endpoints = part.split('/')[0].match(/\d+/g) || [];
            if (endpoints.some((number) => Number(number) > 59)) return false;
        }
    }
    return cron.validate(value);
}

export const matchingSettingsValuesSchema = z.object({
    candidateMode: z.enum(['vector', 'knn']),
    frontierEnabled: z.boolean(),
    cacheTtlMinutes: z.number().int().min(0).max(43200),
    surpriseFloor: z.number().min(0).max(1),
    surpriseMargin: z.number().min(0).max(1),
    emptyEncounter: z.number().min(0).max(1),
    emptyMixed: z.number().min(0).max(1),
    minScore: z.number().min(0).max(1),
    minServeScore: z.number().min(0).max(1),
    wMin: z.number().min(0).max(1),
    weightSem: z.number().min(0).max(1),
    weightRep: z.number().min(0).max(1),
    weightProx: z.number().min(0).max(1),
    weightFresh: z.number().min(0).max(1),
    pairBias: z.number().min(0).max(1),
    maxResults: z.number().int().min(1).max(500),
    frontierSeeds: z.number().int().min(1).max(20),
    sweepEnabled: z.boolean(),
    sweepBatch: z.number().int().min(1).max(20000),
    sweepCron: z.string().trim().min(1).max(120).refine(
        isValidMatchingSweepCron,
        'Invalid cron expression'
    ),
}).strict();

export const matchingSettingsPatchSchema = matchingSettingsValuesSchema.partial()
    .extend({ expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
    .strict()
    .refine(
        (input) => Object.entries(input).some(([key, value]) => key !== 'expectedRevision' && value !== undefined),
        'At least one matching setting is required'
    );

export const matchingSettingsValidation = {
    update: z.object({ body: matchingSettingsPatchSchema }),
};
