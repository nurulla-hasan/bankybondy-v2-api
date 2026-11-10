/* MercadoPago service (Checkout Pro). Creates a Preference and returns the
 * payment URL (init_point), in parallel with the PayPal flow. Subscriptions are
 * keyed by plan type in external_reference, never by amount, since MP charges in
 * the configured currency (ARS by default). */
import { Preference } from 'mercadopago';
import httpStatus from 'http-status';
import config from '../config';
import AppError from '../error/appError';
import { mpClient } from './mpClient';
import { esTipoPlan, PLANES } from '../modules/normalUser/subscriptionPlans';
import { usdToPesos } from './dollarRate';

// Browser return URLs (shared by subscription and donation).
const backUrls = {
    success: config.mercadopago.success_url as string,
    failure: config.mercadopago.failure_url as string,
    pending: config.mercadopago.pending_url as string,
};

// MP rejects auto_return without back_urls.success, so only enable it when a
// success URL is configured.
const autoReturn = backUrls.success ? ('approved' as const) : undefined;

export const createSubscriptionPreference = async (
    userId: string,
    type: 'Standard' | 'Premium'
): Promise<{ url: string }> => {
    // Plan USD target converted to pesos at today's rate. Price comes from
    // `subscriptionPlans`, the same source as the public pricing endpoint: shown
    // and charged amounts cannot diverge because they are the same number.
    if (!esTipoPlan(type) || PLANES[type].usdMercadopago <= 0) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'MercadoPago price not configured for this plan'
        );
    }
    const usd = PLANES[type].usdMercadopago;

    // Today's price in pesos (server-side source of truth).
    const price = await usdToPesos(usd);

    const result = await new Preference(mpClient).create({
        body: {
            items: [
                {
                    id: type,
                    title: 'Bankybondy ' + type,
                    quantity: 1,
                    unit_price: price,
                    currency_id: config.mercadopago.currency,
                },
            ],
            // Purpose, recipient and EXPECTED PRICE travel in external_reference:
            // SUBSCRIPTION:<type>:<userId>:<expectedPesos>. The 4th field is the
            // amount sanity band: without it the webhook could only check
            // `amount > 0`. Recalculating the rate at webhook time fails because
            // the blue rate moves; sending the exact quoted price makes the check
            // exact.
            external_reference:
                'SUBSCRIPTION:' + type + ':' + userId + ':' + price,
            back_urls: backUrls,
            ...(autoReturn ? { auto_return: autoReturn } : {}),
            notification_url: config.mercadopago.webhook_url,
            // THE PREFERENCE EXPIRES: the init_point embeds a peso price quoted
            // NOW, and MP does not expire it by default, so without this the link
            // stays payable forever at today's price. It also closes the amount
            // band for preferences created before the expected price existed.
            // 24 h is roomy to decide a payment and short enough to stay near the rate.
            expires: true,
            expiration_date_to: new Date(
                Date.now() +
                    (Number(process.env.MP_PREFERENCE_HOURS) || 24) * 3600_000
            ).toISOString(),
            // SINGLE PAYMENT, NO INSTALLMENTS. Otherwise Checkout Pro offers the
            // account's enabled installments, and with interest the buyer pays the
            // financing cost — contradicting the promise that the shown price is
            // the checkout price. `installments: 1` also matches what the
            // subscription IS: paid once, never expires.
            payment_methods: {
                installments: 1,
            },
        },
    });

    return { url: result.init_point as string };
};

export const createDonationPreference = async (
    donationId: string,
    amount: number
): Promise<{ url: string }> => {
    // Donation amount (in USD) converted to today's pesos.
    const price = await usdToPesos(amount);
    const result = await new Preference(mpClient).create({
        body: {
            items: [
                {
                    id: 'donation',
                    title: 'Donación Bankybondy',
                    quantity: 1,
                    unit_price: price,
                    currency_id: config.mercadopago.currency,
                },
            ],
            // DONATE:<donationId>
            external_reference: 'DONATE:' + donationId,
            back_urls: backUrls,
            ...(autoReturn ? { auto_return: autoReturn } : {}),
            notification_url: config.mercadopago.webhook_url,
        },
    });

    return { url: result.init_point as string };
};
