import {
    construirFiltroClaim,
    esCheckoutReutilizable,
    normalizarProveedor,
    STALE_CLAIM_MS,
    TTL_REUSO_MS,
} from './subscriptionCheckout';

const AHORA = 1_700_000_000_000;
const hace = (ms: number) => new Date(AHORA - ms);

const base = {
    plan: 'Standard',
    provider: 'paypal',
    url: 'https://paypal.example/approve',
};

const filtro = construirFiltroClaim('Standard', 'paypal', AHORA);
const ramas = (filtro.$or || []) as Record<string, any>[];

const casos: [string, boolean][] = [
    [
        'una URL fresca del mismo plan y proveedor se reutiliza',
        esCheckoutReutilizable({ ...base, createdAt: hace(60_000) }, 'Standard', 'paypal', AHORA),
    ],
    [
        'sin URL no hay nada que reutilizar',
        !esCheckoutReutilizable({ ...base, url: '', createdAt: hace(1_000) }, 'Standard', 'paypal', AHORA),
    ],
    [
        'otro plan no se reutiliza',
        !esCheckoutReutilizable({ ...base, createdAt: hace(1_000) }, 'Premium', 'paypal', AHORA),
    ],
    [
        'otro proveedor no se reutiliza',
        !esCheckoutReutilizable({ ...base, createdAt: hace(1_000) }, 'Standard', 'mercadopago', AHORA),
    ],
    [
        'una URL de más de 30 minutos no se reutiliza',
        !esCheckoutReutilizable({ ...base, createdAt: hace(TTL_REUSO_MS + 1) }, 'Standard', 'paypal', AHORA),
    ],
    [
        'una URL justo dentro del TTL sí se reutiliza',
        esCheckoutReutilizable({ ...base, createdAt: hace(TTL_REUSO_MS - 1) }, 'Standard', 'paypal', AHORA),
    ],
    [
        'un pendiente sin createdAt válido no se reutiliza',
        !esCheckoutReutilizable({ ...base, createdAt: undefined }, 'Standard', 'paypal', AHORA),
    ],
    ['provider ausente normaliza a paypal', normalizarProveedor(undefined) === 'paypal'],
    ['provider paypal se mantiene', normalizarProveedor('paypal') === 'paypal'],
    ['provider mercadopago se mantiene', normalizarProveedor('mercadopago') === 'mercadopago'],
    ['provider desconocido normaliza a paypal', normalizarProveedor('stripe') === 'paypal'],
    [
        'el filtro cubre el documento sin checkout pendiente',
        ramas.some((r) => r.pendingSubscriptionCheckout?.$exists === false),
    ],
    [
        'el filtro cubre un pendiente sin createdAt',
        ramas.some((r) => r['pendingSubscriptionCheckout.createdAt']?.$exists === false),
    ],
    [
        'el filtro permite reclamar un pendiente vencido (30 min)',
        ramas.some(
            (r) =>
                r['pendingSubscriptionCheckout.createdAt']?.$lte?.getTime() ===
                AHORA - TTL_REUSO_MS
        ),
    ],
    [
        'el filtro permite reclamar otro plan',
        ramas.some((r) => r['pendingSubscriptionCheckout.plan']?.$ne === 'Standard'),
    ],
    [
        'el filtro permite reclamar otro proveedor',
        ramas.some((r) => r['pendingSubscriptionCheckout.provider']?.$ne === 'paypal'),
    ],
    [
        'un reclamo con url vacía sólo se roba a los 30 s',
        ramas.some(
            (r) =>
                r['pendingSubscriptionCheckout.url']?.$in?.includes('') &&
                r['pendingSubscriptionCheckout.createdAt']?.$lte?.getTime() ===
                    AHORA - STALE_CLAIM_MS
        ),
    ],
];

export const runSubscriptionCheckoutTests = (): {
    pass: number;
    fail: number;
} => {
    let pass = 0,
        fail = 0;
    for (const [name, cond] of casos) {
        if (cond) pass++;
        else {
            fail++;
            // eslint-disable-next-line no-console
            console.error('FAIL:', name);
        }
    }
    return { pass, fail };
};
