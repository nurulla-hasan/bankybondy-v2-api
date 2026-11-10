/* Pure crediting logic (never touches `res`), shared by the redirect capture and
 * the signed PayPal webhook. Idempotent via unique Transaction.transactionId. */
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
    // CHARGED BUT NOT APPLIED: anti-downgrade guard rejected (user already has an
    // equal or higher plan) or the user does not exist. Money did enter and is
    // recorded in Transaction, so it must not be reported as 'credited'.
    | { status: 'not-applied'; reason: string }
    | { status: 'ignored'; reason: string };

// Currency of the charged amount: PayPal charges USD, MercadoPago ARS. Stored
// next to the amount so `amount` never mixes two currencies.
export type TCurrency = 'USD' | 'ARS';

/* Idempotency, for all three functions below. The lock is the unique index of
 * Transaction.transactionId; the 'already' path also re-applies the effect,
 * because a lock taken before a failed effect could never heal on retry.
 * Safe since both effects are idempotent: $set plan, terminal donation status. */

/* ANTI-DOWNGRADE GUARD. Crediting used to $set the plan blind, so a stale gateway
 * retry (the 'already' path re-applies) could permanently downgrade a lifetime
 * plan and lower bondLimit. Enforced inside the updateOne filter, not a prior
 * read: Mongo checks and writes atomically, so concurrent webhooks cannot race. */

/** Applies a plan, never lowering it. Returns whether it wrote.
 *  `$set` keeps the exact limit and is idempotent (retry-safe).
 *  `permitirIgual: false` for fresh charges, `true` for the 'already' path. */
const aplicarPlanSinBajar = async (
    userId: string,
    tipo: TipoPlan,
    permitirIgual = true
): Promise<boolean> => {
    const plan = PLANES[tipo];
    const r = await NormalUser.updateOne(
        {
            _id: userId,
            // Accept by exclusion ($nin of the higher tiers): null, absent and
            // unknown values all pass, so a stale enum value can still be applied.
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
        // Not an error: the guard did its job (or the user is gone). Logged so an
        // operator can see why a payment moved no plan.
        // eslint-disable-next-line no-console
        console.error(
            `[subscription] NO se aplicó ${tipo} a ${userId}: el usuario no existe o ya tiene un plan igual o mayor (anti-downgrade).`
        );
        return false;
    }
    return true;
};

/** Clears the pending checkout once a payment of that plan applied.
 *  Best-effort: the record expires on its own. */
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

/** Records that this charge's effect did apply. Best-effort: worst case a
 *  redelivery re-applies the same idempotent plan. */
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

/** Flags a charge as charged-but-not-applied: the refund list. Best-effort. */
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
    // Id comes from PayPal `custom_id` / MP external_reference. An unusable id
    // must never reach mongoose: findByIdAndUpdate(undefined) filters on {} and
    // writes the FIRST user in the collection.
    if (!esObjectIdUsable(userId)) {
        return { status: 'ignored', reason: 'invalid user id' };
    }

    const amt = Number(amount);
    const plan = planPorMontoUsd(amt);
    // Unrecognized amount: do not credit (blocks amount-tampering escalation).
    if (!plan) return { status: 'ignored', reason: `unexpected amount ${amt}` };

    const tipoAplicado = plan.tipo;
    // Fresh charge: an equal or higher plan is not re-applied -> not-applied.
    const applyFresh = () => aplicarPlanSinBajar(userId, tipoAplicado, false);
    // Retry of the SAME charge: re-applying is an idempotent $set, so it heals.
    const applyPlan = () => aplicarPlanSinBajar(userId, tipoAplicado);

    // Idempotency lock: unique transactionId prevents double crediting.
    try {
        await Transaction.create({
            user: userId,
            type: ENUM_TRANSACTION_TYPE.SUBSCRIPTION,
            amount: amt,
            currency,
            // Store the plan for the dashboard Income breakdown (known here).
            plan: plan.tipo,
            transactionId,
        });
    } catch (error: unknown) {
        if ((error as { code?: number })?.code === 11000) {
            // Retry of a charge whose effect may have died after the lock. Re-apply
            // only if never applied: otherwise this path undoes a human revocation
            // (chargeback) on every gateway redelivery. `applied` is the only thing
            // separating those two cases; a bare 11000 cannot.
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

    // Do NOT drop the result here (unlike the 'already' path): if nothing was
    // applied, someone paid and got nothing, and calling it 'credited' would lie.
    const aplicado = await applyFresh();
    if (!aplicado) {
        // Stays applied:false: the queryable "paid and got nothing" list, kept
        // even if the gateway retries.
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

/** MercadoPago charges in ARS, so credit by plan TYPE from the server-built
 *  `external_reference` instead of by amount. */
export const creditSubscriptionByType = async (
    userId: string,
    transactionId: string,
    planType: string,
    amount: number,
    currency: TCurrency = 'USD'
): Promise<CreditResult> => {
    // Same id guard as the amount path: unusable ids never reach mongoose.
    if (!esObjectIdUsable(userId)) {
        return { status: 'ignored', reason: 'invalid user id' };
    }

    // Unknown plan — or Free, which is not sold — is not credited (blocks
    // external_reference tampering).
    if (!esTipoPlan(planType) || PLANES[planType].nivel === 0) {
        return { status: 'ignored', reason: `unexpected plan ${planType}` };
    }

    const tipoAplicado = planType;
    // Fresh charge: an equal or higher plan is not re-applied -> not-applied.
    const applyFresh = () => aplicarPlanSinBajar(userId, tipoAplicado, false);
    // Retry of the SAME charge: idempotent $set, see the note on the amount path.
    const applyPlan = () => aplicarPlanSinBajar(userId, tipoAplicado);

    // Idempotency lock: unique transactionId prevents double crediting.
    try {
        await Transaction.create({
            user: userId,
            type: ENUM_TRANSACTION_TYPE.SUBSCRIPTION,
            amount: Number(amount),
            currency,
            // Store the plan for the Income breakdown; explicit here, since ARS
            // amounts cannot infer it.
            plan: planType,
            transactionId,
        });
    } catch (error: unknown) {
        if ((error as { code?: number })?.code === 11000) {
            // Same condition as the amount path: re-apply only if it never was.
            // Matters more here: MP sends several notifications per payment and
            // retries for hours or days.
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

    // Do NOT drop the result here (unlike the 'already' path): if nothing was
    // applied, someone paid and got nothing, and calling it 'credited' would lie.
    const aplicado = await applyFresh();
    if (!aplicado) {
        // Stays applied:false: the queryable "paid and got nothing" list, kept
        // even if the gateway retries.
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
    // Same guard as the subscription functions: the server builds the
    // external_reference, but an invalid id would raise CastError -> 500 -> the
    // gateway retries that payment forever.
    if (!esObjectIdUsable(donationId)) {
        return { status: 'ignored', reason: 'invalid donation id' };
    }
    const donation = await Donate.findById(donationId);
    if (!donation) return { status: 'ignored', reason: 'donation not found' };
    if (donation.status === ENUM_DONATE_STATUS.Paid) {
        return { status: 'already' };
    }

    // Paid is terminal, so repeating it is harmless; called on both exits for the
    // idempotency reason above.
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
            // Donation reached here still not Paid (checked above): lock taken but
            // status never marked — exactly the stuck case, so mark it now.
            await markPaid();
            return { status: 'already' };
        }
        throw error;
    }

    await markPaid();
    return { status: 'credited' };
};
