/* eslint-disable @typescript-eslint/no-explicit-any */
/* Moderación visual de una imagen (portada de audio) con OpenAI omni-moderation.
 *
 * La moderación de audio solo mira el transcript; la portada (`cover_image`) la
 * sube el usuario y se muestra en todo el feed sin ningún chequeo → una imagen
 * NSFW pasaba con un audio lícito. Acá la moderamos por URL.
 *
 * Semántica del veredicto: `checked` dice si se PUDO verificar. Ante un error
 * técnico (OpenAI caído / 429 / timeout / imagen no soportada) devolvemos
 * `{ checked: false }` en vez de aprobar a ciegas: el llamador decide (para el
 * audio, NO aprobar y reintentar — misma política que el análisis de audio). Así
 * un fallo transitorio no publica una portada sin moderar de forma permanente.
 *
 * `interpretImageModeration` es PURA → testeable en runTests.
 */
import OpenAI from 'openai';
import { errorLogger } from '../shared/logger';

// Cliente PEREZOSO: no se instancia al importar el módulo, para que el test pueda
// importar `interpretImageModeration` sin `OPENAI_API_KEY` (el SDK v6 lanza si
// falta). En runtime la key es obligatoria de hecho (otros módulos instancian
// OpenAI eager al bootear), así que acá siempre estará.
let client: OpenAI | null = null;
const getClient = (): OpenAI => {
    // Techo de tiempo, igual que isTextSafe.ts y embedding.ts: con los defaults
    // del SDK (600 s y 2 reintentos) una portada colgada frenaba hasta ~30 min el
    // barrido de audio, que es serial, para todos.
    if (!client)
        client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            timeout: 15000,
            maxRetries: 1,
        });
    return client;
};

export type ImageVerdict = { safe: boolean; reason?: string };
export type ImageModerationResult = { checked: boolean } & ImageVerdict;

// Interpreta el resultado de `openai.moderations.create`. flagged=true → unsafe
// con las categorías marcadas como motivo. Resultado ausente/raro → safe.
export const interpretImageModeration = (result: any): ImageVerdict => {
    const r = result?.results?.[0];
    if (!r || typeof r.flagged !== 'boolean') return { safe: true };
    if (!r.flagged) return { safe: true };
    const cats =
        r.categories && typeof r.categories === 'object'
            ? Object.keys(r.categories).filter((k) => r.categories[k])
            : [];
    return { safe: false, reason: cats.length ? cats.join(', ') : 'flagged' };
};

export const moderateImageUrl = async (
    url: string
): Promise<ImageModerationResult> => {
    // Sin URL no hay imagen que moderar (cover es required; esto es defensivo).
    if (!url || typeof url !== 'string') return { checked: true, safe: true };
    try {
        const result = await getClient().moderations.create({
            model: 'omni-moderation-latest',
            input: [{ type: 'image_url', image_url: { url } }],
        });
        // 200 pero sin un veredicto válido (shape inesperado): tratar como NO
        // verificada (fail-closed), no como segura — así el llamador reintenta en
        // vez de publicar una portada sin moderar de verdad.
        const r = (result as any)?.results?.[0];
        if (!r || typeof r.flagged !== 'boolean') {
            errorLogger.error('[moderateImage] respuesta sin veredicto válido');
            return { checked: false, safe: false };
        }
        return { checked: true, ...interpretImageModeration(result) };
    } catch (e) {
        errorLogger.error(
            '[moderateImage] no se pudo verificar (error técnico):',
            (e as Error)?.message
        );
        return { checked: false, safe: false };
    }
};
