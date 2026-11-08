/* Reutilización del checkout pendiente de suscripción.
 *
 * El checkout de PayPal/MercadoPago se crea por request. Sin memoria, dos
 * pestañas o un doble submit producen DOS URLs pagables del mismo plan y la
 * persona puede pagar las dos (la suscripción es de por vida: no hay renovación
 * que lo corrija después).
 *
 * Acá vive la decisión pura: cuándo se puede reutilizar la URL guardada y cuándo
 * se puede reclamar el documento para crear una nueva. El filtro de `claim` es
 * la autoridad atómica; estas funciones existen para testear esa lógica sin base.
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

/** Una URL se reutiliza 30 minutos: suficiente para terminar un pago y corto
 *  para que un checkout abandonado no quede pagable para siempre. */
export const TTL_REUSO_MS = 30 * 60_000;

/** Un reclamo con `url: ''` es “estoy creando la orden”. Si se cayó el proceso
 *  en el medio, a los 30 s otro request puede tomarlo; antes de eso, no, porque
 *  pisarlo crearía exactamente la segunda URL que esto viene a evitar. */
export const STALE_CLAIM_MS = 30_000;

/** `provider` es opcional en la API y su ausencia significa PayPal. */
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

/** Condiciones bajo las que el documento puede pasar a ser el checkout vigente.
 *
 *  Lo que NO matchea (y por eso devuelve 409 en el servicio) es el caso normal
 *  de una pestaña que llega mientras otra ya tiene un checkout fresco del mismo
 *  plan y proveedor: ahí no hay nada que crear, hay una URL que devolver.
 *
 *  `$ne` e `$in: [null, '']` matchean paths ausentes, así que las ramas de
 *  “campo faltante” son defensivas; la de `url: ''` sí exige antigüedad, que es
 *  lo que impide robar un reclamo vivo. */
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
