import { z } from 'zod';

// Cotas de monto de donación (anti-abuso: micro-donaciones que solo generan
// ruido/costo de checkout, y montos absurdos por error de tipeo). Env-overridable;
// el máximo por defecto es GENEROSO para no cortar donaciones legítimas. OJO: el
// `amount` de /donate está SIEMPRE en USD (PayPal cobra en USD y la vía MP hace
// usdToPesos(amount)), así que estas cotas son en USD, no en pesos.
const DONATION_MIN_AMOUNT = Number(process.env.DONATION_MIN_AMOUNT || 1);
const DONATION_MAX_AMOUNT = Number(process.env.DONATION_MAX_AMOUNT || 1_000_000);

const createDonateSchema = z.object({
    body: z.object({
        amount: z
            .number({ required_error: 'Amount is required' })
            .min(DONATION_MIN_AMOUNT, {
                message: `Amount must be at least ${DONATION_MIN_AMOUNT}`,
            })
            .max(DONATION_MAX_AMOUNT, { message: 'Amount is too large' }),
        provider: z.enum(['paypal', 'mercadopago']).optional(),
    }),
});

export const DonateValidations = {
    createDonateSchema,
};
