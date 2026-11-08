/* Lógica de acreditación PURA (sin tocar res), reutilizable por:
 *  - la captura vía redirect (/capture-payment)
 *  - el webhook firmado de PayPal (fuente de verdad)
 * La idempotencia se garantiza con el índice único de Transaction.transactionId
 * y con el estado de la donación. */
import { ENUM_DONATE_STATUS } from '../modules/donate/donate.enum';
import { Donate } from '../modules/donate/donate.model';
import NormalUser from '../modules/normalUser/normalUser.model';
import {
    esTipoPlan,
    PLANES,
    planPorMontoUsd,
    tiposHastaNivelDe,
    type TipoPlan,
} from '../modules/normalUser/subscriptionPlans';
import Transaction from '../modules/transaction/transaction.model';
import { ENUM_TRANSACTION_TYPE } from '../utilities/enum';
import { esObjectIdUsable } from '../utilities/objectId';

export type CreditResult =
    | { status: 'credited' }
    | { status: 'already' }
    // SE COBRÓ PERO NO SE PUDO APLICAR: la guarda anti-downgrade rechazó (el
    // usuario ya tiene un plan igual o mayor) o el usuario no existe. Es un
    // estado distinto de 'credited' y de 'ignored', y merece su propio nombre:
    // 'credited' sería mentir (no se aplicó nada) e 'ignored' también (la plata
    // SÍ entró y quedó registrada en Transaction). Quien lo reciba tiene que
    // saber que hay una persona que pagó y no recibió, para resolverlo con la
    // palanca del dashboard.
    | { status: 'not-applied'; reason: string }
    | { status: 'ignored'; reason: string };

// Moneda del importe cobrado. PayPal cobra en USD; MercadoPago en ARS (el precio
// se convierte con la cotización del día). Se guarda junto al monto para que la
// columna `amount` no mezcle dos monedas.
export type TCurrency = 'USD' | 'ARS';

/* NOTA sobre la idempotencia (vale para las tres funciones de abajo).
 *
 * El candado es el índice único de Transaction.transactionId. Antes se tomaba el
 * candado y RECIÉN DESPUÉS se aplicaba el efecto (el plan / marcar la donación).
 * Si el efecto fallaba por algo transitorio, el webhook devolvía 500, la pasarela
 * reintentaba, y el reintento chocaba con el candado ya puesto -> devolvía
 * 'already' y cortaba ANTES del efecto. Resultado: el usuario pagó, el cobro
 * quedó registrado, y el plan/la donación no se aplicaban NUNCA. Ningún reintento
 * podía arreglarlo: hacía falta tocar la base a mano.
 *
 * Ahora el camino 'already' TAMBIÉN aplica el efecto. Es seguro porque los dos
 * efectos son idempotentes: el plan usa $set (fija el valor exacto, no suma) y
 * marcar la donación como pagada es un estado terminal. Así el reintento de la
 * pasarela cura el hueco solo. */

/* ═════════════════════════════════════════════════════════════════════════════
 * LA GUARDA ANTI-DOWNGRADE — el defecto GRAVE que cerraba esta tanda.
 *
 * Las dos funciones de acreditación hacían `$set` del plan sin mirar el actual.
 * Con la suscripción DE POR VIDA eso es plata perdida para siempre, porque no hay
 * renovación que lo cure. El escenario, entero y alcanzable:
 *
 *   1. Alguien paga Standard. Se acredita bien.
 *   2. Más adelante paga Premium. Se acredita bien.
 *   3. MercadoPago reintenta la notificación del pago Standard VIEJO — y lo hace
 *      durante HORAS O DÍAS si alguna vez no recibió un 2xx (un 500 nuestro, un
 *      deploy a destiempo, un timeout).
 *   4. El reintento choca contra el candado de idempotencia (`transactionId`
 *      único) → devuelve 11000 → y el camino `already` **vuelve a aplicar el
 *      plan**, que es correcto y deliberado (cura las acreditaciones que murieron
 *      a mitad de camino) pero acá aplica STANDARD sobre un PREMIUM.
 *   5. Esa persona queda en Standard PARA SIEMPRE, con su bondLimit bajado de
 *      1000 a 100, habiendo pagado los dos planes. Nadie se entera.
 *
 * SE RESUELVE EN EL FILTRO, NO CON UN `findById` PREVIO. Un "leer el plan actual
 * y decidir" abre una carrera entre dos webhooks concurrentes. Poniendo los tipos
 * aceptables en el filtro del `updateOne`, Mongo hace la comprobación y la
 * escritura en una sola operación atómica: si el usuario ya está en un plan MAYOR,
 * el filtro sencillamente no matchea y no se escribe nada.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Aplica un plan SIN PODER BAJARLO. Devuelve si escribió.
 *
 *  `$set` y no `$inc` (fix previo que se conserva): `$inc` sumaba sobre el default
 *  del plan gratis (25), así que Standard quedaba sumado y las repeticiones se
 *  acumulaban (210, 1010...). `$set` deja el límite exacto del plan siempre, y es
 *  idempotente, que es lo que permite re-aplicar en el camino `already`.
 *
 *  `permitirIgual` distingue los dos usos:
 *  · `false` (cobro NUEVO): un plan igual o mayor ya está puesto, así que este
 *    pago no se puede aplicar → `not-applied` y queda en la lista de reembolsos.
 *  · `true` (camino `already`): la acreditación original pudo morir a mitad y el
 *    reintento de la pasarela tiene que curarla; re-aplicar el mismo plan es un
 *    `$set` idempotente. */
const aplicarPlanSinBajar = async (
    userId: string,
    tipo: TipoPlan,
    permitirIgual = true
): Promise<boolean> => {
    const plan = PLANES[tipo];
    const r = await NormalUser.updateOne(
        {
            _id: userId,
            // Sólo si el plan actual vale MENOS O IGUAL que el que se acredita,
            // Y SE EXPRESA POR LO QUE **NO** PUEDE SER, no por lo que sí.
            //
            // La versión anterior era una lista blanca (`$in` de los tipos de nivel
            // menor o igual) más dos ramas para null y ausente. Cubría esos dos
            // casos pero NO un valor DESCONOCIDO —un `'Basic'` de un enum viejo, un
            // typo en una migración— y ahí las dos guardas se contradecían:
            // `nivelDe` lo trata como 0 y lo deja comprar, pero la lista blanca no
            // lo matchea y no se le aplica nada. Pagaba y no recibía.
            //
            // Con `$nin` de los niveles MAYORES, todo lo que no sea explícitamente
            // un plan superior pasa: null, ausente y desconocido quedan cubiertos de
            // una sola vez, y por construcción, no por enumeración.
            subscriptionType: {
                $nin: (Object.keys(PLANES) as TipoPlan[]).filter((t) =>
                    permitirIgual
                        ? PLANES[t].nivel > PLANES[tipo].nivel
                        : PLANES[t].nivel >= PLANES[tipo].nivel
                ),
            },
        },
        { $set: { subscriptionType: tipo, bondLimit: plan.bondLimit } },
        { runValidators: true }
    );
    if (!r.matchedCount) {
        // No es un error: es la guarda haciendo su trabajo (o un usuario que no
        // existe). Se loguea porque un operador tiene que poder ver por qué un
        // pago no movió el plan, y tiene la palanca del dashboard para resolverlo.
        // eslint-disable-next-line no-console
        console.error(
            `[subscription] NO se aplicó ${tipo} a ${userId}: el usuario no existe o ya tiene un plan igual o mayor (anti-downgrade).`
        );
        return false;
    }
    return true;
};

/** Borra el checkout pendiente cuando un pago de ese plan se aplicó.
 *  Best-effort: si falla, el registro vence solo y no afecta la acreditación. */
const limpiarCheckoutPendiente = async (
    userId: string,
    tipo: TipoPlan
): Promise<void> => {
    try {
        await NormalUser.updateOne(
            { _id: userId, 'pendingSubscriptionCheckout.plan': tipo },
            { $unset: { pendingSubscriptionCheckout: '' } }
        );
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error(
            '[subscription] no se pudo limpiar el checkout pendiente:',
            userId,
            (e as Error)?.message
        );
    }
};

/** Marca que el efecto de este cobro SÍ llegó a aplicarse. Best-effort: si falla,
 *  el peor caso es que una re-entrega futura vuelva a aplicar el mismo plan, que
 *  es idempotente. Nunca debe romper una acreditación que ya salió bien. */
const marcarAplicada = async (transactionId: string): Promise<void> => {
    try {
        await Transaction.updateOne(
            { transactionId },
            { $set: { applied: true } }
        );
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error(
            '[subscription] no se pudo marcar la transacción como aplicada:',
            transactionId,
            (e as Error)?.message
        );
    }
};

/** Marca el cobro como “se cobró y no se aplicó”: es la lista de reembolsos.
 *  Best-effort: si falla, queda el `applied:false` original y el log. */
const marcarReembolsoPendiente = async (
    transactionId: string
): Promise<void> => {
    try {
        await Transaction.updateOne(
            { transactionId },
            { $set: { refundPending: true } }
        );
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error(
            '[subscription] no se pudo marcar el reembolso pendiente:',
            transactionId,
            (e as Error)?.message
        );
    }
};

export const creditSubscription = async (
    userId: string,
    transactionId: string,
    amount: number | string,
    currency: TCurrency = 'USD'
): Promise<CreditResult> => {
    // El id viene de `custom_id` de PayPal / del external_reference de MP. La
    // firma del webhook ya es la barrera principal, pero un id inusable NO puede
    // llegar a mongoose: `findByIdAndUpdate(undefined)` arma el filtro `{}` y
    // escribe sobre el PRIMER usuario de la colección. Es la clase de bug que ya
    // mordió una vez en este repo (ver la guarda de auth.ts).
    if (!esObjectIdUsable(userId)) {
        return { status: 'ignored', reason: 'invalid user id' };
    }

    const amt = Number(amount);
    const plan = planPorMontoUsd(amt);
    // Importe no reconocido: no acreditar (evita escalada por manipulación de importe).
    if (!plan) return { status: 'ignored', reason: `unexpected amount ${amt}` };

    const tipoAplicado = plan.tipo;
    // Cobro NUEVO: un plan igual o mayor no se re-aplica; queda `not-applied`.
    const applyFresh = () => aplicarPlanSinBajar(userId, tipoAplicado, false);
    // Reintento del MISMO cobro: curar una acreditación que murió a mitad es un
    // `$set` idempotente, así que acá sí se permite re-aplicar.
    const applyPlan = () => aplicarPlanSinBajar(userId, tipoAplicado);

    // Candado de idempotencia: transactionId único evita doble acreditación.
    try {
        await Transaction.create({
            user: userId,
            type: ENUM_TRANSACTION_TYPE.SUBSCRIPTION,
            amount: amt,
            currency,
            // Guardar el plan (Standard | Premium) para el desglose Income del
            // dashboard. Acá lo sabemos con certeza por el monto (10/25 USD).
            plan: plan.tipo,
            transactionId,
        });
    } catch (error: unknown) {
        if ((error as { code?: number })?.code === 11000) {
            // Ver NOTA de arriba: puede ser un reintento de una acreditación que
            // murió después del candado, y re-aplicar el plan cura ese hueco.
            //
            // PERO SÓLO SI NUNCA SE APLICÓ. Sin esta condición, el camino
            // `already` **deshacía una revocación humana**: se revoca un Premium
            // por contracargo con la palanca del dashboard, la pasarela re-entrega
            // cualquier notificación de ese pago (un reenvío manual desde el
            // panel, un reintento, un `payment.updated` por la propia disputa),
            // se choca el candado, y el plan vuelve. De por vida y en silencio,
            // con el historial diciendo "Free".
            //
            // Era el cruce de dos arreglos que nunca se reconciliaron: re-aplicar
            // en `already` (de una ronda) contra la palanca de revocación (de la
            // siguiente). `applied` los reconcilia: distingue "la acreditación
            // murió a mitad" de "se aplicó bien y después alguien la cambió a
            // propósito", que es justo lo que el 11000 pelado no puede distinguir.
            const previa = await Transaction.findOne({ transactionId })
                .select('applied refundPending')
                .lean();
            if ((previa as any)?.applied === true) {
                return { status: 'already' };
            }
            if ((previa as any)?.refundPending === true) {
                return {
                    status: 'not-applied',
                    reason: 'plan already owned or higher (refund pending)',
                };
            }
            if (await applyPlan()) {
                await marcarAplicada(transactionId);
                await limpiarCheckoutPendiente(userId, tipoAplicado);
            }
            return { status: 'already' };
        }
        throw error;
    }

    // Acá NO se descarta el resultado (a diferencia del camino `already`): si no
    // se aplicó, hay alguien que pagó y no recibió, y decir 'credited' sería mentir.
    const aplicado = await applyFresh();
    if (!aplicado) {
        // La Transaction queda con `applied: false`: es el registro consultable
        // de "esta persona pagó y no recibió". `Transaction.find({applied:false})`
        // es la lista de a quién hay que reparar con la palanca del dashboard.
        // Queda en la lista de reembolsos incluso si la pasarela reintenta.
        await marcarReembolsoPendiente(transactionId);
        return {
            status: 'not-applied',
            reason: 'usuario inexistente o con un plan igual o mayor',
        };
    }
    await marcarAplicada(transactionId);
    await limpiarCheckoutPendiente(userId, tipoAplicado);
    return { status: 'credited' };
};

/** MercadoPago cobra en ARS, así que NO se puede acreditar por importe: se
 *  acredita por TIPO de plan, que viaja en el `external_reference` que arma
 *  nuestro propio servidor. */
export const creditSubscriptionByType = async (
    userId: string,
    transactionId: string,
    planType: string,
    amount: number,
    currency: TCurrency = 'USD'
): Promise<CreditResult> => {
    // Misma guarda del id que en la vía por monto: un id inusable no puede llegar
    // a mongoose.
    if (!esObjectIdUsable(userId)) {
        return { status: 'ignored', reason: 'invalid user id' };
    }

    // Plan no reconocido —o `Free`, que no se compra— no se acredita: evita
    // escalada por manipulación del external_reference.
    if (!esTipoPlan(planType) || PLANES[planType].nivel === 0) {
        return { status: 'ignored', reason: `unexpected plan ${planType}` };
    }

    const tipoAplicado = planType;
    // Cobro NUEVO: un plan igual o mayor no se re-aplica; queda `not-applied`.
    const applyFresh = () => aplicarPlanSinBajar(userId, tipoAplicado, false);
    // Reintento del MISMO cobro: ver la nota del camino por monto.
    const applyPlan = () => aplicarPlanSinBajar(userId, tipoAplicado);

    // Candado de idempotencia: transactionId único evita doble acreditación.
    try {
        await Transaction.create({
            user: userId,
            type: ENUM_TRANSACTION_TYPE.SUBSCRIPTION,
            amount: Number(amount),
            currency,
            // Guardar el plan para el desglose Income. En MercadoPago (ARS) el
            // monto no permite inferirlo, pero acá lo recibimos explícito.
            plan: planType,
            transactionId,
        });
    } catch (error: unknown) {
        if ((error as { code?: number })?.code === 11000) {
            // MISMA CONDICIÓN que en la vía por monto: se re-aplica sólo si el
            // efecto nunca llegó a aplicarse. Ver el comentario largo allá.
            //
            // Y acá importa MÁS que en PayPal: MercadoPago manda varias
            // notificaciones por el mismo pago (`payment.created`,
            // `payment.updated`) y reintenta durante horas o días si alguna vez no
            // recibió un 2xx. Es la vía por la que una revocación por contracargo
            // se deshacía sola con más probabilidad.
            const previa = await Transaction.findOne({ transactionId })
                .select('applied refundPending')
                .lean();
            if ((previa as any)?.applied === true) {
                return { status: 'already' };
            }
            if ((previa as any)?.refundPending === true) {
                return {
                    status: 'not-applied',
                    reason: 'plan already owned or higher (refund pending)',
                };
            }
            if (await applyPlan()) {
                await marcarAplicada(transactionId);
                await limpiarCheckoutPendiente(userId, tipoAplicado);
            }
            return { status: 'already' };
        }
        throw error;
    }

    // Acá NO se descarta el resultado (a diferencia del camino `already`): si no
    // se aplicó, hay alguien que pagó y no recibió, y decir 'credited' sería mentir.
    const aplicado = await applyFresh();
    if (!aplicado) {
        // La Transaction queda con `applied: false`: es el registro consultable
        // de "esta persona pagó y no recibió". `Transaction.find({applied:false})`
        // es la lista de a quién hay que reparar con la palanca del dashboard.
        // Queda en la lista de reembolsos incluso si la pasarela reintenta.
        await marcarReembolsoPendiente(transactionId);
        return {
            status: 'not-applied',
            reason: 'usuario inexistente o con un plan igual o mayor',
        };
    }
    await marcarAplicada(transactionId);
    await limpiarCheckoutPendiente(userId, tipoAplicado);
    return { status: 'credited' };
};

export const creditDonation = async (
    donationId: string,
    transactionId: string,
    amount: number | string,
    currency: TCurrency = 'USD'
): Promise<CreditResult> => {
    // Misma guarda que las dos funciones de suscripción. El external_reference lo
    // arma el servidor, así que no es atacable; sin esto, un id inválido produce
    // un CastError -> 500 -> la pasarela reintenta ese pago indefinidamente.
    if (!esObjectIdUsable(donationId)) {
        return { status: 'ignored', reason: 'invalid donation id' };
    }
    const donation = await Donate.findById(donationId);
    if (!donation) return { status: 'ignored', reason: 'donation not found' };
    if (donation.status === ENUM_DONATE_STATUS.Paid) {
        return { status: 'already' };
    }

    // Marcar la donación como pagada es un estado terminal, así que repetirlo no
    // cambia nada. Se llama en las dos salidas por el motivo de la NOTA de arriba.
    const markPaid = async () => {
        donation.status = ENUM_DONATE_STATUS.Paid;
        donation.transactionId = transactionId;
        await donation.save();
    };

    try {
        await Transaction.create({
            user: donation.user,
            type: ENUM_TRANSACTION_TYPE.DONATION,
            amount: Number(amount),
            currency,
            transactionId,
        });
    } catch (error: unknown) {
        if ((error as { code?: number })?.code === 11000) {
            // La donación llegó acá SIN estar en Paid (se chequea arriba), así que
            // este es justamente el caso que quedaba colgado: candado puesto y
            // donación sin marcar. Se marca ahora.
            await markPaid();
            return { status: 'already' };
        }
        throw error;
    }

    await markPaid();
    return { status: 'credited' };
};
