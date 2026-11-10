import { z } from 'zod';

// Donation amount bounds (anti-abuse), env-overridable. Always in USD: PayPal
// charges in USD and the MP path converts via usdToPesos.
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
