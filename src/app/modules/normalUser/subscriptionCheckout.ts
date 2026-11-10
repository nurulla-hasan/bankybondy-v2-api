/* Reuse of the pending subscription checkout.
 *
 * The PayPal/MercadoPago checkout is created per request. Without memory, two
 * tabs or a double submit produce TWO payable URLs for the same plan and the
 * person can pay both (the subscription is lifetime: no renewal fixes it).
 *
 * The pure decision lives here: when the stored URL can be reused and when the
 * doc can be claimed to create a new one. The `claim` filter is the atomic
 * authority; these functions exist to test that logic without a DB.
 */
import type { FilterQuery } from 'mongoose';
import type { INormalUser } from './normalUser.interface';
import type { TipoPlan } from './subscriptionPlans';

export type ProveedorCheckout = 'paypal' | 'mercadopago';

export interface CheckoutPendiente {
    plan?: string;
    provider?: string;
    url?: string;
    createdAt?: Date;
}

/** A URL is reused for 30 minutes: enough to finish a payment, short enough that
 *  an abandoned checkout does not stay payable forever. */
export const TTL_REUSO_MS = 30 * 60_000;

/** A claim with `url: ''` means "I am creating the order". If the process died
 *  mid-way, after 30 s another request may take it; before that, no, because
 *  overwriting it would create exactly the second URL this avoids. */
export const STALE_CLAIM_MS = 30_000;

/** `provider` is optional in the API and its absence means PayPal. */
export const normalizarProveedor = (
    provider: string | undefined
): ProveedorCheckout =>
    provider === 'mercadopago' ? 'mercadopago' : 'paypal';

export const esCheckoutReutilizable = (
    pending: CheckoutPendiente | null | undefined,
    plan: TipoPlan,
    provider: ProveedorCheckout,
    ahora: number = Date.now()
): boolean => {
    if (!pending?.url || !(pending.createdAt instanceof Date)) return false;
    if (pending.plan !== plan || pending.provider !== provider) return false;
    return ahora - pending.createdAt.getTime() < TTL_REUSO_MS;
};

/** Conditions for the doc to become the current checkout.
 *
 *  A non-match (409 in the service) is the normal case of a tab arriving while
 *  another already has a fresh checkout of the same plan and provider: nothing
 *  to create, just a URL to return.
 *
 *  `$ne` and `$in: [null, '']` match absent paths, so the "missing field"
 *  branches are defensive; the `url: ''` branch requires age, which is what
 *  prevents stealing a live claim. */
export const construirFiltroClaim = (
    plan: TipoPlan,
    provider: ProveedorCheckout,
    ahora: number = Date.now()
): FilterQuery<INormalUser> => ({
    $or: [
        { pendingSubscriptionCheckout: { $exists: false } },
        { 'pendingSubscriptionCheckout.createdAt': { $exists: false } },
        {
            'pendingSubscriptionCheckout.createdAt': {
                $lte: new Date(ahora - TTL_REUSO_MS),
            },
        },
        { 'pendingSubscriptionCheckout.plan': { $ne: plan } },
        { 'pendingSubscriptionCheckout.provider': { $ne: provider } },
        {
            'pendingSubscriptionCheckout.url': { $in: [null, ''] },
            'pendingSubscriptionCheckout.createdAt': {
                $lte: new Date(ahora - STALE_CLAIM_MS),
            },
        },
    ],
});
