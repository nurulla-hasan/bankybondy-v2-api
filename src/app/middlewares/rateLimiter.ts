/* eslint-disable no-console */
import rateLimit, { Store } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createClient } from 'redis';
import config from '../config';

// Cliente Redis único (la conexión) para el store distribuido, si hay REDIS_URL;
// si no, cada limiter cae a su propio MemoryStore por defecto.
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

// IMPORTANTE: cada limiter DEBE tener su PROPIA instancia de RedisStore.
// `rate-limit-redis` guarda el `windowMs` POR STORE (en su init), y
// `express-rate-limit` llama init una vez por limiter sobre la instancia que le
// pasás. Compartir UNA sola instancia hacía que el windowMs del ÚLTIMO limiter
// creado (contact = 1h) pisara a TODOS → los locks quedaban de 1 HORA en vez de
// 1 minuto (bug P1). Además, un `prefix` distinto por limiter evita que las claves
// colisionen entre sí (p.ej. auth y contact compartían clave por IP). Se comparte
// la conexión (redisClient), no la instancia de store.
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
    windowMs: 15 * 60 * 1000, // 15 minutos
    limit: 20, // 20 intentos por ventana por IP
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    store: makeStore('rl-auth:'),
    // Fail-open: si Redis (store) falla, NO bloquear (mejor sin limite momentaneo
    // que 500 en login/creacion). Redis local single-instance = SPOF.
    passOnStoreError: true,
    message: {
        success: false,
        message: 'Too many attempts. Please try again later.',
    },
});

// Límite de creación de bonds por USUARIO (anti-bot / protección de capacidad).
// Env-overridable: BOND_CREATE_RATE_LIMIT (creates permitidos por minuto y por
// usuario). Por defecto 15. Debe montarse DESPUÉS del middleware `auth`, para
// que `req.user` ya esté poblado y la clave sea el id del usuario autenticado
// (no la IP: comparte NAT/proxy). Usa su propia instancia de store vía
// makeStore('rl-bond:') (Redis si hay REDIS_URL, MemoryStore si no) para que el
// conteo sea coherente entre instancias y con su propio windowMs.
const BOND_CREATE_RATE_LIMIT = Number(
    process.env.BOND_CREATE_RATE_LIMIT || 15
);

export const bondCreateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minuto
    limit: BOND_CREATE_RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    store: makeStore('rl-bond:'),
    // Fail-open: si Redis (store) falla, NO bloquear (mejor sin limite momentaneo
    // que 500 en login/creacion). Redis local single-instance = SPOF.
    passOnStoreError: true,
    // Clave por usuario autenticado (profileId/id inyectado por `auth`). Fallback
    // defensivo a la IP si por algún motivo no hubiese usuario en la request.
    keyGenerator: (req) =>
        `bond-create:${req.user?.profileId || req.user?.id || req.ip}`,
    message: {
        success: false,
        message: 'Estás creando vínculos muy rápido, esperá un momento.',
    },
});

// Límite de SUBIDA de audios por USUARIO (EC3, Tanda 0). Cada subida dispara un
// pipeline caro: subida a S3 + ffmpeg + transcripción OpenAI + análisis OpenAI.
// Sin límite, un bucle podía disparar costos de OpenAI descontrolados y saturar
// el worker. Se limita por usuario autenticado (no IP: comparte NAT). Debe
// montarse DESPUÉS de `auth` y ANTES de `uploadFile()`, para rechazar ANTES de
// subir el archivo a S3. Env-overridable por AUDIO_UPLOAD_RATE_LIMIT.
const AUDIO_UPLOAD_RATE_LIMIT = Number(
    process.env.AUDIO_UPLOAD_RATE_LIMIT || 5
);

export const audioUploadLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minuto
    limit: AUDIO_UPLOAD_RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    store: makeStore('rl-audio:'),
    // Fail-open: si Redis falla, no bloquear (mejor sin límite momentáneo que 500).
    passOnStoreError: true,
    keyGenerator: (req) =>
        `audio-upload:${req.user?.profileId || req.user?.id || req.ip}`,
    message: {
        success: false,
        message: 'Estás subiendo audios muy rápido, esperá un momento.',
    },
});

// E0: registrar una escucha hace 1 lectura + 1 escritura en DB por request. Cap
// generoso por usuario (el uso real navega varios audios por minuto; el conteo
// igual está deduplicado por día) para frenar el flood sin molestar.
export const audioListenLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minuto
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

// Límite de CREACIÓN de checkouts por USUARIO (donación/suscripción). Crear
// órdenes/preferencias llama APIs externas (PayPal/MP) y deja registros
// pendientes; sin límite, una sesión válida podía generar ruido y costo
// operacional. Se limita por usuario autenticado (no IP: comparte NAT). Debe
// montarse DESPUÉS de `auth`. Env-overridable por CHECKOUT_CREATE_RATE_LIMIT.
// Store propio vía makeStore('rl-checkout:') (misma corrección que EC3).
const CHECKOUT_CREATE_RATE_LIMIT = Number(
    process.env.CHECKOUT_CREATE_RATE_LIMIT || 10
);

export const checkoutCreateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minuto
    limit: CHECKOUT_CREATE_RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    store: makeStore('rl-checkout:'),
    // Fail-open: si Redis falla, no bloquear (mejor sin límite momentáneo que 500).
    passOnStoreError: true,
    keyGenerator: (req) =>
        `checkout-create:${req.user?.profileId || req.user?.id || req.ip}`,
    message: {
        success: false,
        message: 'Estás intentando iniciar pagos muy rápido, esperá un momento.',
    },
});

// Límite de /contact-us. Es un endpoint PÚBLICO y sin autenticación que dispara
// un email en cada request: sin límite, cualquiera podía inundar la casilla de
// soporte con un bucle. Se limita por IP porque no hay usuario. Más estricto que
// `authLimiter` (5 por hora) porque nadie escribe a soporte cinco veces seguidas
// de forma legítima. Env-overridable por CONTACT_RATE_LIMIT.
const CONTACT_RATE_LIMIT = Number(process.env.CONTACT_RATE_LIMIT || 5);

export const contactLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
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

// Límite de /consumidor/solicitud (botón de arrepentimiento y de baja). Mismo caso
// que /contact-us —público, sin auth, manda mails— pero con prefijo propio: es un
// DERECHO del consumidor y no puede quedar bloqueado porque alguien usó antes el
// formulario de contacto desde la misma IP. Más holgado por lo mismo, y el mensaje
// ofrece el mail, que los Términos (7.3) también aceptan como canal.
// Env-overridable por CONSUMIDOR_RATE_LIMIT.
const CONSUMIDOR_RATE_LIMIT = Number(process.env.CONSUMIDOR_RATE_LIMIT || 10);

export const consumidorLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
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

/** Precios de los planes: endpoint PÚBLICO, sin auth, y con efecto SALIENTE.
 *
 *  La convención del repo para esa combinación ya existe y está escrita en
 *  `app.ts`: `contactLimiter` está puesto justamente porque es un endpoint
 *  público sin auth que dispara algo hacia afuera. Éste es el mismo caso: con la
 *  caché de la cotización vencida o caída, cada request puede terminar en un
 *  `axios.get` a dolarapi con timeout de 5 s.
 *
 *  El límite es holgado a propósito (60/min por IP): es una lectura barata en el
 *  camino feliz y no queremos que un NAT compartido se quede sin ver los precios.
 *  Lo que acota es la ráfaga, que es lo único que hace daño. */
export const pricesLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.PRICES_RATE_LIMIT) || 60,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    store: makeStore('rl-prices:'),
    // Fail-open, igual que el resto: mejor sin límite un rato que 500 en la
    // pantalla donde la gente paga.
    passOnStoreError: true,
    message: {
        success: false,
        message: 'Demasiadas consultas de precios. Probá de nuevo en un momento.',
    },
});
