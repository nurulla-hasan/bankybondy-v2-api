/* eslint-disable @typescript-eslint/no-explicit-any */
/* Image moderation for the audio cover with OpenAI omni-moderation.
 *
 * `checked: false` means the verdict could not be obtained (error/429/timeout);
 * the caller decides (audio refuses and retries) so a transient failure never
 * publishes an unmoderated cover permanently. `interpretImageModeration` is pure.
 */
import OpenAI from 'openai';
import { errorLogger } from '../shared/logger';

// Lazy client: not instantiated on import, so tests can load
// `interpretImageModeration` without `OPENAI_API_KEY` (SDK v6 throws if missing).
let client: OpenAI | null = null;
const getClient = (): OpenAI => {
    // Time cap: SDK defaults (600s, 2 retries) could stall the serial audio sweep
    // for ~30 min on one hung cover.
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

// Interprets `openai.moderations.create` output. flagged=true → unsafe with the
// flagged categories as reason. Missing/odd result → safe.
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
    // No URL means nothing to moderate (cover is required; defensive).
    if (!url || typeof url !== 'string') return { checked: true, safe: true };
    try {
        const result = await getClient().moderations.create({
            model: 'omni-moderation-latest',
            input: [{ type: 'image_url', image_url: { url } }],
        });
        // 200 without a valid verdict (unexpected shape): treat as NOT verified
        // (fail-closed) so the caller retries instead of publishing it.
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
