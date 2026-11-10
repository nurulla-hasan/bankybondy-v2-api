/* Subscription plans: single source of truth for USD prices and bond limits.
 * Lifetime (no expiry field); `nivel` exists so a bad downgrade never sticks. */
import { ENUM_SUBSCRIPTION_TYPE } from './normalUser.enum';

export type TipoPlan = 'Free' | 'Standard' | 'Premium';

// Read `process.env` directly (not `app/config`): the latter validates all env with zod
// on import, which would put this paid-plan logic out of reach of the DB-less test runner.
const num = (v: string | number | undefined, def: number): number => {
    const n = Number(v);
    // Round to 2 decimals: PayPal charges with `toFixed(2)` and credit compares the amount
    // that comes back against this number (9.999 charged as 10 never credits).
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : def;
};

export type Plan = {
    tipo: TipoPlan;
    /** Value order. Only upgrades, never an automatic downgrade. */
    nivel: number;
    bondLimit: number;
    /** USD charged via PayPal. 0 = free. */
    usdPaypal: number;
    /** USD target that MercadoPago converts to local currency. 0 = not applicable. */
    usdMercadopago: number;
};

// Literal keys, not computed from the enum: computed keys lose literal types and
// `Record<TipoPlan, Plan>` would stop guaranteeing all three. The check below fails at startup.
export const PLANES: Record<TipoPlan, Plan> = {
    Free: {
        tipo: 'Free',
        nivel: 0,
        bondLimit: 25,
        usdPaypal: 0,
        usdMercadopago: 0,
    },
    Standard: {
        tipo: 'Standard',
        nivel: 1,
        bondLimit: 100,
        usdPaypal: num(process.env.PAYPAL_USD_STANDARD, 10),
        usdMercadopago: num(process.env.MP_USD_STANDARD, 8),
    },
    Premium: {
        tipo: 'Premium',
        nivel: 2,
        bondLimit: 1000,
        usdPaypal: num(process.env.PAYPAL_USD_PREMIUM, 25),
        usdMercadopago: num(process.env.MP_USD_PREMIUM, 15),
    },
};

// If this file and the enum drift apart, the anti-downgrade guard would compare against
// types the DB rejects and payments would stop crediting silently. Fail at import instead.
for (const t of Object.values(ENUM_SUBSCRIPTION_TYPE)) {
    if (!Object.prototype.hasOwnProperty.call(PLANES, t)) {
        throw new Error(
            `subscriptionPlans: falta el plan "${t}", que SÍ está en ENUM_SUBSCRIPTION_TYPE.`
        );
    }
}

// Second guard: PayPal credits by amount, so two plans sharing one `usdPaypal` (an `.env`
// typo) would charge Premium and hand out Standard, forever and silently. Fail at startup.
{
    const precios = Object.values(PLANES)
        .filter((p) => p.usdPaypal > 0)
        .map((p) => p.usdPaypal);
    if (new Set(precios).size !== precios.length) {
        throw new Error(
            'subscriptionPlans: dos planes tienen el MISMO precio de PayPal ' +
                `(${precios.join(', ')}). PayPal acredita por monto, así que se ` +
                'cobraría un plan y se entregaría otro. Revisá PAYPAL_USD_STANDARD / PAYPAL_USD_PREMIUM.'
        );
    }
}

export const esTipoPlan = (v: unknown): v is TipoPlan =>
    typeof v === 'string' && Object.prototype.hasOwnProperty.call(PLANES, v);

/** Plan level; unknown or missing means 0 (Free).
 *
 *  Part of the anti-downgrade guard, so the default matters: a high value blocks a
 *  legitimate credit, -1 lets any payment overwrite a Premium. 0 = "no plan". */
export const nivelDe = (tipo: unknown): number =>
    esTipoPlan(tipo) ? PLANES[tipo].nivel : 0;

/** Plan types whose level is <= the one of `tipo`.
 *
 *  Used as the credit filter: an old Standard webhook cannot overwrite a credited
 *  Premium, and the check is atomic (it ships in the update filter, no prior read). */
export const tiposHastaNivelDe = (tipo: TipoPlan): TipoPlan[] =>
    (Object.keys(PLANES) as TipoPlan[]).filter(
        (t) => PLANES[t].nivel <= PLANES[tipo].nivel
    );

/** Plan for a PayPal USD amount. `null` if none matches (blocks amount-tampering escalation). */
export const planPorMontoUsd = (monto: number | string): Plan | null => {
    const m = Number(monto);
    if (!Number.isFinite(m)) return null;
    return (
        (Object.values(PLANES).find(
            (p) => p.usdPaypal > 0 && p.usdPaypal === m
        ) as Plan | undefined) ?? null
    );
};

export default PLANES;
