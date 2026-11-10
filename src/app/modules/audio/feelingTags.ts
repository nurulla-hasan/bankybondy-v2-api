// Controlled Spanish "feeling tags" vocabulary: what an audio made the listener feel.
// Canonical (accented) values are stored and returned; an accent-less slug only matches
// input case/accent-insensitively.
export const FEELING_TAGS = [
    'calma',
    'seguridad',
    'belleza',
    'reflexivo',
    'profundo',
    'claro',
    'entusiasta',
    'conmovedor',
    'emotivo',
    'inspirador',
    'sereno',
    'cálido',
    'honesto',
    'poético',
    'esperanzador',
    'íntimo',
    'vibrante',
    'luminoso',
    'tierno',
    'nostálgico',
    'enérgico',
    'sabio',
    'auténtico',
    'delicado',
    'envolvente',
    'motivador',
    'relajante',
    'curioso',
    'valiente',
    'agradecido',
    'divertido',
    'genuino',
] as const;

export type FeelingTag = (typeof FEELING_TAGS)[number];

// Unicode range of combining diacritical marks (U+0300 to U+036F).
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

// Normalize to slug: strip accents, trim, lowercase.
const slugify = (value: string): string =>
    value
        .normalize('NFD')
        .replace(COMBINING_MARKS, '')
        .trim()
        .toLowerCase();

const SLUG_TO_CANONICAL: Record<string, string> = FEELING_TAGS.reduce(
    (acc, tag) => {
        acc[slugify(tag)] = tag;
        return acc;
    },
    {} as Record<string, string>
);

// True if the value (case/accent-insensitive) belongs to the vocabulary.
export const isValidFeelingTag = (value: string): boolean =>
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(SLUG_TO_CANONICAL, slugify(value));

// Return the canonical (accented) value, or null if not in the vocabulary.
export const toCanonicalFeelingTag = (value: string): string | null =>
    typeof value === 'string'
        ? SLUG_TO_CANONICAL[slugify(value)] ?? null
        : null;

// Normalize a list: map to canonical, drop invalid entries and dedupe.
export const normalizeFeelingTags = (values: string[]): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const v of values || []) {
        const canonical = toCanonicalFeelingTag(v);
        if (canonical && !seen.has(canonical)) {
            seen.add(canonical);
            result.push(canonical);
        }
    }
    return result;
};
