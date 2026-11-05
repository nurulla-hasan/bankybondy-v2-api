// Vocabulario controlado (estable) de "feeling tags" en espanol: lo que un audio
// le hizo SENTIR al oyente. Se guardan los valores canonicos (con acentos) y esos
// mismos son las etiquetas de display que expone la API. Internamente se usa un
// "slug" (sin acentos, minusculas) solo para hacer el matching del input tolerante
// a mayusculas/acentos, pero SIEMPRE se almacena/retorna el valor canonico.
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

// Rango Unicode de marcas diacriticas combinantes (U+0300 a U+036F).
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

// Normaliza a slug: quita acentos, recorta y pasa a minusculas.
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

// true si el valor (tolerante a mayusculas/acentos) pertenece al vocabulario.
export const isValidFeelingTag = (value: string): boolean =>
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(SLUG_TO_CANONICAL, slugify(value));

// Devuelve el valor canonico (con acentos) o null si no pertenece al vocabulario.
export const toCanonicalFeelingTag = (value: string): string | null =>
    typeof value === 'string'
        ? SLUG_TO_CANONICAL[slugify(value)] ?? null
        : null;

// Normaliza una lista: mapea a canonico, descarta invalidos y quita duplicados.
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
