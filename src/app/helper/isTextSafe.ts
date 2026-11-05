/* eslint-disable @typescript-eslint/no-explicit-any */
import OpenAI from 'openai';
import httpStatus from 'http-status';
import AppError from '../error/appError';

// TECHO EXPLÍCITO DE TIEMPO. El SDK sin `timeout` espera MINUTOS y reintenta
// solo, y estas llamadas corren ANTES de guardar CADA mensaje del chat y ANTES de
// publicar cada vínculo. Con OpenAI degradado, todo eso quedaba colgado minutos
// mientras la burbuja del que escribió ya decía "enviado".
//
// QUÉ HACE EL TECHO EN CADA CAMINO — y esto lo corrigió el panel del 26/9, porque
// una versión anterior de este comentario afirmaba lo que el código NO hace:
//
//   · VÍNCULOS y AUDIO (`isTextSafeBatch` / `assertTextAllowed`): fail-CLOSED
//     amable y retryable, como declara la Opción A de abajo. El techo hace que ese
//     rechazo llegue en segundos en vez de en minutos. Ahí el comentario viejo
//     era cierto.
//   · CHAT (`isMessageSafe`, que llama `handleChat`): **falla ABIERTO**. El chat
//     sólo emite 422 `message_blocked` y el front sólo maneja ese 422 — no hay
//     ningún camino de 503 ni de reintento. O sea: con el techo, un OpenAI lento
//     pasa a fail-OPEN *antes* que sin él. Es deliberado y está asumido: en este
//     producto perder un mensaje pesa más que dejar pasar uno sin moderar, y cada
//     caso queda logueado como `msg-fail-open`.
//
// Y el número real es ~30 s, no 15: el SDK REINTENTA los timeouts, así que con
// `maxRetries: 1` el techo total son dos intentos de 15 s.
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 15000,
    maxRetries: 1,
});

/* ============================================================================
 * Bankybondy · isTextSafe — 3 capas de Trust & Safety
 *  Capa 1  Lista dura LOCAL bilingue (ES+EN). Solo terminos/frases inequivocos
 *          y graves + DINERO por FRASES (nunca palabras sueltas).
 *  Capa 2  Moderacion OpenAI (omni-moderation-latest), red multilingue.
 *  Capa 3  Intencion (gpt-4o-mini) con salida ESTRUCTURADA (JSON).
 *  Politica de fallo (Opcion A): si la MODERACION no se puede verificar ->
 *          fail-CLOSED amable (retryable); la INTENCION puede fail-OPEN.
 *  Eficiencia: batch (offer+want en 1 llamada) + cache en memoria.
 *  Observabilidad: log de cada decision.
 * ========================================================================== */

export interface SafetyResult {
    safe: boolean;
    reason?: string;
    category?: string;
    retryable?: boolean;
}

/**
 * Lanza el error correcto según el verdict de moderación:
 *  - retryable (la moderación NO se pudo verificar → fail-closed): 503 con el
 *    mensaje de reintento. NO se dice "no permitido" porque el contenido puede
 *    estar perfecto; es un problema TRANSITORIO del servicio.
 *  - unsafe real: 400 "<label> is not allowed: <motivo>".
 *  - safe (o null/undefined): no hace nada.
 */
export const assertTextAllowed = (
    verdict: SafetyResult | null | undefined,
    label: string
): void => {
    if (!verdict || verdict.safe) return;
    if (verdict.retryable) {
        throw new AppError(
            httpStatus.SERVICE_UNAVAILABLE,
            verdict.reason ||
                'Estamos revisando tu contenido. Proba de nuevo en un minuto.'
        );
    }
    throw new AppError(
        httpStatus.BAD_REQUEST,
        `${label} is not allowed: ${verdict.reason}`
    );
};

const MSG = {
    money: 'No se permiten pagos ni dinero: Bankybondy es una plataforma de trueque.',
    drugs: 'No se permiten drogas.',
    weapons: 'No se permiten armas ni explosivos.',
    sexual: 'No se permite contenido sexual explicito.',
    minors: 'Contenido no permitido.',
    trafficking: 'Contenido no permitido.',
    moderation: 'El contenido infringe las politicas de seguridad.',
    intent: 'Contenido no autorizado para esta plataforma.',
    retry: 'Estamos revisando tu contenido. Proba de nuevo en un minuto.',
};

const normalize = (s: string): string =>
    (s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .trim();

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const build = (terms: string[]) =>
    new RegExp(`\\b(?:${terms.map(esc).join('|')})\\b`, 'i');

const RE_DRUGS = build([
    'cocaina', 'cocaine', 'heroina', 'heroin',
    'metanfetamina', 'methamphetamine', 'meth',
    'fentanilo', 'fentanyl', 'mdma', 'extasis', 'ecstasy', 'lsd',
    'ketamina', 'ketamine', 'crack cocaine',
    'marihuana', 'marijuana', 'cannabis', 'hashish', 'hachis',
]);

const RE_WEAPONS = build([
    'rifle', 'escopeta', 'shotgun', 'fusil', 'ak-47', 'ak47', 'metralleta',
    'municion', 'municiones', 'ammunition', 'arma de fuego',
    'firearm', 'firearms', 'handgun',
    'grenade', 'hand grenade', 'granada de mano',
    'explosivo', 'explosivos', 'explosive', 'explosives',
    'dinamita', 'dynamite',
]);

const RE_MINORS = build([
    'abuso de menores', 'abuso infantil', 'abuso sexual infantil',
    'child abuse', 'child sexual abuse',
    'pornografia infantil', 'child porn', 'child pornography', 'csam',
    'pedofilia', 'pedofilo', 'pedophile', 'pedophilia',
    'explotacion infantil', 'child exploitation',
]);

const RE_TRAFFICKING = build([
    'trata de personas', 'trata de blancas',
    'human trafficking', 'sex trafficking',
    'trafico de personas', 'trafico humano',
    'trafico de organos', 'organ trafficking',
    'esclavitud sexual', 'sexual slavery',
]);

const RE_SEXUAL = build([
    'porn', 'porno', 'pornografia', 'pornography', 'xxx',
    'escort', 'escorts', 'onlyfans', 'stripper', 'nudes',
    'prostituta', 'prostituto', 'prostitute', 'prostitucion', 'prostitution',
    'servicios sexuales', 'sexual services', 'favores sexuales', 'sexual favors',
    'trabajo sexual', 'sexo por dinero', 'sex for money',
    'sugar daddy', 'sugar baby',
]);

const RE_MONEY_PHRASE = build([
    'en efectivo', 'solo efectivo', 'pago en efectivo',
    'in cash', 'cash only', 'for cash',
    'por dinero', 'for money',
    'a cambio de dinero', 'a cambio de plata',
    'in exchange for money', 'in exchange for cash', 'money in exchange',
]);

const RE_MONEY_AMOUNT =
    /(?:\b\d+(?:[.,]\d+)?\s*(?:pesos|euros|dolares|dollars|usd|reales)\b)|(?:(?:\$|€|£|u\$s|us\$|ar\$|r\$)\s?\d)|(?:\d\s?(?:\$|€|£))/i;

function hardCheck(norm: string): { category: string; reason: string } | null {
    if (RE_DRUGS.test(norm)) return { category: 'drugs', reason: MSG.drugs };
    if (RE_WEAPONS.test(norm)) return { category: 'weapons', reason: MSG.weapons };
    if (RE_MINORS.test(norm)) return { category: 'minors', reason: MSG.minors };
    if (RE_TRAFFICKING.test(norm))
        return { category: 'trafficking', reason: MSG.trafficking };
    if (RE_SEXUAL.test(norm)) return { category: 'sexual', reason: MSG.sexual };
    if (RE_MONEY_PHRASE.test(norm) || RE_MONEY_AMOUNT.test(norm))
        return { category: 'money', reason: MSG.money };
    return null;
}

interface IntentVerdict {
    block: boolean;
    category: string;
    reason: string;
}

const INTENT_SYSTEM = `
Sos el sistema de autorizacion de contenido de Bankybondy, una plataforma de
TRUEQUE entre adultos responsables: se intercambian bienes y habilidades legales
SIN dinero de por medio.

REGLA DE ORO: lo UNICO que importa es que NO haya dinero. El VALOR y la CANTIDAD
de los bienes NO importan: cambiar una casa por dos departamentos, una empresa por
otra, un auto por una lancha, o cualquier bien caro por otro, es trueque VALIDO.
Nunca bloquees por SUPONER que un bien de valor "se compra con plata".

Devolves SIEMPRE JSON valido con esta forma exacta:
{"results":[{"index":<n>,"block":<true|false>,"category":"<cat>","reason":"<motivo corto en espanol>"}]}

BLOQUEA (block=true) SOLO si el texto:
- Menciona EXPLICITAMENTE dinero como pago o cobro del intercambio: "te pago",
  "te lo pago", "cobro", pone un PRECIO ("$500", "vale X pesos"), "efectivo",
  "sena/senia en plata", "acepto transferencia/mercadopago/paypal/cripto", etc.
  (Rigido con el pago REAL; NO con suponer pago donde solo se nombra un bien.)
- Ofrece o pide drogas, armas/explosivos, servicios sexuales, contenido sexual
  explicito, trata/explotacion, o cualquier bien/servicio ILEGAL.
- Es una estafa, fraude o intercambio enganoso.
- Es violento, de odio o incita a hacer dano.

PERMITI (block=false) TODO trueque legitimo de bienes o habilidades, sin importar
su valor ni cantidad. Ejemplos que se PERMITEN:
- CUALQUIER bien como objeto de trueque: casa, departamento, terreno, auto, moto,
  bici, lancha, empresa, celular, herramientas, electrodomesticos, etc.
  "Busco una moto", "Cambio casa por 2 departamentos", "Ofrezco mi empresa por
  otra", "Auto por lancha" => PERMITIDO.
- Dinero como TEMA o HABILIDAD (no como pago): "Enseno educacion financiera /
  contabilidad", "Ofrezco un anillo de plata" (plata = metal, no dinero).
- "Ayuda con la mudanza a cambio de clases de ingles" (trueque de habilidades).
- Compania, apoyo emocional, tiempo, favores no monetarios. "Sos un crack" (elogio).

Categorias validas: "money","drugs","weapons","sexual","minors","trafficking",
"violence","hate","scam","illegal","other". Si block=false usa "none".
El "reason" va en espanol, breve, apto para mostrar al usuario.
`.trim();

async function classifyIntentBatch(texts: string[]): Promise<IntentVerdict[]> {
    const numbered = texts
        .map((t, i) => `#${i}: ${t.replace(/\s+/g, ' ').slice(0, 500)}`)
        .join('\n');

    const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: INTENT_SYSTEM },
            { role: 'user', content: `Analiza cada item y devolve el JSON.\n\n${numbered}` },
        ],
    });

    const raw = res.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    const arr: any[] = Array.isArray(parsed) ? parsed : parsed.results;
    if (!Array.isArray(arr)) throw new Error('intent: malformed response');

    return texts.map((_, i) => {
        const item = arr.find((x) => Number(x?.index) === i) ?? arr[i] ?? null;
        if (!item || typeof item.block !== 'boolean')
            return { block: false, category: 'none', reason: '' };
        return {
            block: item.block,
            category: String(item.category || 'other'),
            reason: String(item.reason || ''),
        };
    });
}

function moderationCategory(result: any): string | null {
    if (!result?.flagged) return null;
    const cats = result.categories || {};
    const hit = Object.keys(cats).find((k) => cats[k] === true);
    return hit || 'flagged';
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 5000;
const cache = new Map<string, { r: SafetyResult; exp: number }>();

function cacheGet(key: string): SafetyResult | null {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.exp) {
        cache.delete(key);
        return null;
    }
    cache.delete(key);
    cache.set(key, hit);
    return hit.r;
}

function cacheSet(key: string, r: SafetyResult): void {
    if (r.retryable) return;
    if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { r, exp: Date.now() + CACHE_TTL_MS });
}

function logDecision(layer: string, text: string, r: SafetyResult): void {
    // eslint-disable-next-line no-console
    console.info('[isTextSafe]', JSON.stringify({
        layer,
        safe: r.safe,
        category: r.category ?? null,
        preview: (text || '').replace(/\s+/g, ' ').slice(0, 120),
    }));
}

export async function isTextSafeBatch(rawTexts: string[]): Promise<SafetyResult[]> {
    const results: SafetyResult[] = new Array(rawTexts.length);
    const pending: { i: number; text: string; norm: string }[] = [];

    for (let i = 0; i < rawTexts.length; i++) {
        const text = rawTexts[i] ?? '';
        const norm = normalize(text);

        if (!norm) {
            results[i] = { safe: true };
            continue;
        }
        const cached = cacheGet(norm);
        if (cached) {
            results[i] = cached;
            continue;
        }
        const hard = hardCheck(norm);
        if (hard) {
            const r: SafetyResult = { safe: false, reason: hard.reason, category: hard.category };
            cacheSet(norm, r);
            logDecision('hard', text, r);
            results[i] = r;
            continue;
        }
        pending.push({ i, text, norm });
    }

    if (pending.length === 0) return results;

    const inputs = pending.map((p) => p.text);

    const [modSettled, intentSettled] = await Promise.allSettled([
        openai.moderations.create({ model: 'omni-moderation-latest', input: inputs }),
        classifyIntentBatch(inputs),
    ]);

    const modFailed = modSettled.status === 'rejected';
    const mod = modSettled.status === 'fulfilled' ? modSettled.value : null;
    const intent = intentSettled.status === 'fulfilled' ? intentSettled.value : null;

    pending.forEach((p, k) => {
        if (modFailed) {
            const r: SafetyResult = {
                safe: false,
                reason: MSG.retry,
                category: 'service_unavailable',
                retryable: true,
            };
            logDecision('fail-closed', p.text, r);
            results[p.i] = r;
            return;
        }
        const modCat = mod ? moderationCategory((mod as any).results?.[k]) : null;
        if (modCat) {
            const r: SafetyResult = { safe: false, reason: MSG.moderation, category: `moderation:${modCat}` };
            cacheSet(p.norm, r);
            logDecision('moderation', p.text, r);
            results[p.i] = r;
            return;
        }
        const v = intent ? intent[k] : null;
        if (v && v.block) {
            const r: SafetyResult = { safe: false, reason: v.reason || MSG.intent, category: `intent:${v.category}` };
            cacheSet(p.norm, r);
            logDecision('intent', p.text, r);
            results[p.i] = r;
            return;
        }
        const ok: SafetyResult = { safe: true };
        cacheSet(p.norm, ok);
        logDecision(intent ? 'pass' : 'pass(intent-open)', p.text, ok);
        results[p.i] = ok;
    });

    return results;
}

export async function isTextSafe(text: string): Promise<SafetyResult> {
    const [r] = await isTextSafeBatch([text]);
    return r;
}

/* ----------------------------------------------------------------------------
 * isMessageSafe — versión LIVIANA y GRATIS para el chat.
 *  - Capa 1 (lista dura local) + Capa 2 (moderación OpenAI). SIN la capa 3 de
 *    intención (gpt-4o-mini, la única paga) → costo ~US$0.
 *  - Falla ABIERTO: si la moderación de OpenAI no responde, se PERMITE el
 *    mensaje (la lista dura local ya cubre lo más grave) para NO cortar el chat.
 *  - Caché con prefijo propio ('msg:') para NO mezclarse con la de vínculos: un
 *    "safe" de 2 capas nunca debe hacer que un vínculo salte su capa de intención.
 * -------------------------------------------------------------------------- */
export async function isMessageSafe(text: string): Promise<SafetyResult> {
    const norm = normalize(text);
    if (!norm) return { safe: true };
    const key = 'msg:' + norm;

    const cached = cacheGet(key);
    if (cached) return cached;

    // Capa 1: lista dura local (gratis, siempre disponible).
    const hard = hardCheck(norm);
    if (hard) {
        const r: SafetyResult = {
            safe: false,
            reason: hard.reason,
            category: hard.category,
        };
        cacheSet(key, r);
        logDecision('msg-hard', text, r);
        return r;
    }

    // Capa 2: moderación OpenAI (gratis). Fail-OPEN ante error/caída.
    try {
        const mod = await openai.moderations.create({
            model: 'omni-moderation-latest',
            input: text,
        });
        const modCat = moderationCategory((mod as any).results?.[0]);
        if (modCat) {
            const r: SafetyResult = {
                safe: false,
                reason: MSG.moderation,
                category: `moderation:${modCat}`,
            };
            cacheSet(key, r);
            logDecision('msg-moderation', text, r);
            return r;
        }
    } catch {
        // No romper el chat si la moderación no está disponible.
        logDecision('msg-fail-open', text, { safe: true });
        return { safe: true };
    }

    const ok: SafetyResult = { safe: true };
    cacheSet(key, ok);
    logDecision('msg-pass', text, ok);
    return ok;
}
