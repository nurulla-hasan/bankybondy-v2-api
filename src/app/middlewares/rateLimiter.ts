/* eslint-disable no-console */
import rateLimit, { Store } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createClient } from 'redis';
import config from '../config';

// Single Redis connection for the distributed store when REDIS_URL is set;
// otherwise each limiter falls back to its own MemoryStore.
let redisClient: ReturnType<typeof createClient> | undefined;
if (config.redis_url) {
    try {
        redisClient = createClient({ url: config.redis_url });
        redisClient.on('error', (err) =>
            console.error('RateLimit Redis error:', err)
        );
        redisClient.connect().catch((err) =>
            console.error('RateLimit Redis connect failed:', err)
        );
    } catch (err) {
        console.error('RateLimit Redis client unavailable:', err);
    }
}

// Each limiter MUST get its OWN RedisStore: `windowMs` is stored per store on
// init, so sharing one instance let the last limiter's window apply to all.
// Distinct prefixes keep keys from colliding; only the connection is shared.
const makeStore = (prefix: string): Store | undefined => {
    if (!redisClient) return undefined;
    return new RedisStore({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sendCommand: (...args: string[]) =>
            redisClient!.sendCommand(args) as any,
        prefix,
    });
};

export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    limit: 20, // 20 attempts per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    store: makeStore('rl-auth:'),
    // Fail-open: a Redis store failure must not turn login into a 500.
    passOnStoreError: true,
    message: {
        success: false,
        message: 'Too many attempts. Please try again later.',
    },
});

// Bond creation limit per USER (anti-bot / capacity guard). Env:
// BOND_CREATE_RATE_LIMIT (default 15/min). Must be mounted AFTER `auth` so the
// key is the authenticated user id, not a shared NAT IP.
const BOND_CREATE_RATE_LIMIT = Number(
    process.env.BOND_CREATE_RATE_LIMIT || 15
);

export const bondCreateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 min
    limit: BOND_CREATE_RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    store: makeStore('rl-bond:'),
    // Fail-open: a Redis failure must not block creation.
    passOnStoreError: true,
    // Key by authenticated user; IP is only a defensive fallback.
    keyGenerator: (req) =>
        `bond-create:${req.user?.profileId || req.user?.id || req.ip}`,
    message: {
        success: false,
        message: 'Estás creando vínculos muy rápido, esperá un momento.',
    },
});

// Audio upload limit per USER: each upload triggers S3 + ffmpeg + OpenAI
// transcription/analysis. Mount AFTER `auth` and BEFORE `uploadFile()` to reject
// before the S3 upload. Env: AUDIO_UPLOAD_RATE_LIMIT.
const AUDIO_UPLOAD_RATE_LIMIT = Number(
    process.env.AUDIO_UPLOAD_RATE_LIMIT || 5
);

export const audioUploadLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 min
    limit: AUDIO_UPLOAD_RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    store: makeStore('rl-audio:'),
    // Fail-open: a Redis failure must not block uploads.
    passOnStoreError: true,
    keyGenerator: (req) =>
        `audio-upload:${req.user?.profileId || req.user?.id || req.ip}`,
    message: {
        success: false,
        message: 'Estás subiendo audios muy rápido, esperá un momento.',
    },
});

// Registering a listen costs 1 read + 1 write per request. Generous cap (counts
// are already deduped per day) to stop floods without bothering real usage.
export const audioListenLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 min
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    store: makeStore('rl-listen:'),
    passOnStoreError: true,
    keyGenerator: (req) =>
        `audio-listen:${req.user?.profileId || req.user?.id || req.ip}`,
    message: {
        success: false,
        message: 'Demasiadas solicitudes, esperá un momento.',
    },
});

// Checkout creation limit per USER (donation/subscription): each call hits
// PayPal/MP and leaves pending records. Mount AFTER `auth`. Env:
// CHECKOUT_CREATE_RATE_LIMIT.
const CHECKOUT_CREATE_RATE_LIMIT = Number(
    process.env.CHECKOUT_CREATE_RATE_LIMIT || 10
);

export const checkoutCreateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 min
    limit: CHECKOUT_CREATE_RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    store: makeStore('rl-checkout:'),
    // Fail-open: a Redis failure must not block payments.
    passOnStoreError: true,
    keyGenerator: (req) =>
        `checkout-create:${req.user?.profileId || req.user?.id || req.ip}`,
    message: {
        success: false,
        message: 'Estás intentando iniciar pagos muy rápido, esperá un momento.',
    },
});

// /contact-us rate limit: public, unauthenticated, and sends an email per
// request. Keyed by IP (no user). Stricter than `authLimiter` on purpose.
// Env: CONTACT_RATE_LIMIT.
const CONTACT_RATE_LIMIT = Number(process.env.CONTACT_RATE_LIMIT || 5);

export const contactLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    limit: CONTACT_RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    store: makeStore('rl-contact:'),
    passOnStoreError: true,
    message: {
        success: false,
        message: 'Demasiados mensajes. Probá de nuevo más tarde.',
    },
});

// /consumidor/solicitud limit: public, unauthenticated, sends mail. Own prefix so
// a consumer right is never blocked by earlier contact-form use from the same IP.
// Env: CONSUMIDOR_RATE_LIMIT.
const CONSUMIDOR_RATE_LIMIT = Number(process.env.CONSUMIDOR_RATE_LIMIT || 10);

export const consumidorLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    limit: CONSUMIDOR_RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    store: makeStore('rl-consumidor:'),
    passOnStoreError: true,
    message: {
        success: false,
        message:
            'Demasiados pedidos seguidos. Probá de nuevo en un rato o escribinos a bankybondyar@gmail.com.',
    },
});

export default authLimiter;

/** Plan prices: PUBLIC endpoint with an OUTBOUND effect. On an expired or failed
 *  quote cache each request can hit dolarapi with a 5 s timeout. Generous cap
 *  (60/min per IP) — only bursts are harmful. */
export const pricesLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.PRICES_RATE_LIMIT) || 60,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    store: makeStore('rl-prices:'),
    // Fail-open like the rest: better unthrottled than a 500 on the payment screen.
    passOnStoreError: true,
    message: {
        success: false,
        message: 'Demasiadas consultas de precios. Probá de nuevo en un momento.',
    },
});
