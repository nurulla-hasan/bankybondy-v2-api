/* LOS PLANES: fuente ÚNICA de verdad.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POR QUÉ EXISTE ESTE ARCHIVO
 *
 * Los precios y los límites estaban repetidos en CUATRO lugares que tenían que
 * coincidir exacto, y dos de ellos de una forma peligrosa:
 *
 *   · `normalUser.services.ts` COBRA por PayPal (10 / 25 hardcodeados).
 *   · `paypal/creditPayment.ts` ACREDITA POR MONTO (10 → Standard, 25 → Premium).
 *   · `paypal/creditPayment.ts` acredita POR TIPO para MercadoPago (otro mapa).
 *   · `web/.../subscriptions/page.jsx` MUESTRA precios propios.
 *
 * Cambiar el precio en el primero y olvidarse del segundo significa **que se
 * cobra y no se acredita**: la acreditación devuelve `ignored: unexpected amount`,
 * el usuario pagó y no recibe nada, y hace falta tocar la base a mano. En un área
 * cuya vara es *seguro*, eso no puede depender de que alguien se acuerde.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LA SUSCRIPCIÓN ES DE POR VIDA (decisión de Emilio, 26/8). Se paga una vez y no
 * vence. Por eso `NormalUser` no tiene campo de vencimiento, y no es un bug.
 *
 * El corolario importante, y el motivo del `nivel` de acá abajo: si NO hay
 * renovación, un downgrade indebido **no se cura solo nunca**. Ver `nivelDe`.
 *
 * Los precios en USD son overrideables por env, PERO el de PayPal manda sobre las
 * dos puntas a la vez (cobro y acreditación) justamente porque salen de acá.
 */
import { ENUM_SUBSCRIPTION_TYPE } from './normalUser.enum';

export type TipoPlan = 'Free' | 'Standard' | 'Premium';

// Se lee `process.env` DIRECTO y NO se importa `app/config`, siguiendo la misma
// convención que `matching.config.ts`. No es preferencia de estilo: `app/config`
// valida el entorno entero con zod al importarse, así que cualquier módulo que lo
// toque queda fuera del alcance de `scripts/runTests.js`, que corre funciones
// puras sin base, sin red y sin `.env`. Y esta lógica —la que decide si alguien
// que pagó recibe su plan— es exactamente la que más conviene tener testeada.
//
// Los valores del `.env` llegan igual: `dotenv` ya corrió cuando este módulo se
// evalúa (la cadena de imports pasa por `app/config` bastante antes).
const num = (v: string | number | undefined, def: number): number => {
    const n = Number(v);
    // REDONDEO A 2 DECIMALES, y no es cosmético: PayPal se cobra con
    // `totalAmount.toFixed(2)` y la acreditación compara el monto que vuelve
    // contra ESTE número. Un `PAYPAL_USD_STANDARD=9.999` se cobraría como
    // "10.00" y volvería como 10, que no es igual a 9.999 -> `unexpected amount`
    // -> la persona paga y NO recibe nada. Es el mismo modo de falla que este
    // archivo dice eliminar: las dos puntas leen el mismo número, pero había un
    // redondeo en el medio que sólo estaba de un lado.
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : def;
};

export type Plan = {
    tipo: TipoPlan;
    /** Orden de valor. SOLO se sube de nivel, nunca se baja automáticamente. */
    nivel: number;
    bondLimit: number;
    /** Precio en USD que se cobra por PayPal. 0 = no se cobra (Free). */
    usdPaypal: number;
    /** Objetivo en USD que MercadoPago convierte a pesos del día. 0 = no aplica. */
    usdMercadopago: number;
};

// Claves literales y no computadas desde el enum: con claves computadas
// TypeScript pierde los tipos literales y el `Record<TipoPlan, Plan>` deja de
// garantizar que estén los tres. La correspondencia con el enum la asegura el
// chequeo de más abajo, que falla al ARRANCAR si alguna vez divergen.
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

// El modelo valida `subscriptionType` contra ENUM_SUBSCRIPTION_TYPE. Si este
// archivo y el enum se separan, la guarda anti-downgrade compararía contra tipos
// que la base no acepta y los pagos dejarían de acreditarse EN SILENCIO. Mejor
// que reviente acá, al importar, con el nombre del culpable.
for (const t of Object.values(ENUM_SUBSCRIPTION_TYPE)) {
    if (!Object.prototype.hasOwnProperty.call(PLANES, t)) {
        throw new Error(
            `subscriptionPlans: falta el plan "${t}", que SÍ está en ENUM_SUBSCRIPTION_TYPE.`
        );
    }
}

// Y LA SEGUNDA GUARDA, que faltaba y cubre el modo de falla que este archivo dice
// venir a matar: PayPal acredita POR MONTO, así que si dos planes terminan con el
// mismo `usdPaypal` —un typo en el `.env`, nada más— `planPorMontoUsd` devuelve
// el PRIMERO que encuentra. Alguien compra Premium, se le cobran 25 dólares y
// recibe Standard, de por vida y en silencio. Reventar al arrancar es infinitamente
// mejor que descubrirlo por un reclamo.
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

/** Nivel de un plan. Un valor desconocido o ausente vale 0 (Free).
 *
 *  ⚠️ ES LA PIEZA DE LA GUARDA ANTI-DOWNGRADE, así que el default importa: si un
 *  tipo raro devolviera un nivel alto, un pago legítimo no se acreditaría; si
 *  devolviera -1, cualquier pago pisaría un Premium. 0 es el valor correcto:
 *  trata lo desconocido como "sin plan", que es lo que un usuario sin plan es. */
export const nivelDe = (tipo: unknown): number =>
    esTipoPlan(tipo) ? PLANES[tipo].nivel : 0;

/** Los tipos de plan cuyo nivel es MENOR O IGUAL al de `tipo`.
 *
 *  Es lo que se usa como filtro de la acreditación: sólo se aplica el plan si el
 *  usuario está en uno de éstos. Así un webhook viejo de Standard no puede pisar
 *  un Premium ya acreditado, y la comprobación es ATÓMICA (viaja en el filtro del
 *  update, no en un `findById` previo que abriría una carrera). */
export const tiposHastaNivelDe = (tipo: TipoPlan): TipoPlan[] =>
    (Object.keys(PLANES) as TipoPlan[]).filter(
        (t) => PLANES[t].nivel <= PLANES[tipo].nivel
    );

/** El plan que corresponde a un importe en USD de PayPal. `null` si no coincide
 *  con ninguno (evita escalada por manipulación del importe). */
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
