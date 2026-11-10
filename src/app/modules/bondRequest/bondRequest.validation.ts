import { z } from 'zod';

const createBondRequestValidationSchema = z.object({
    body: z.object({
        // `.trim().min(1)`: an empty offer/want passed validation, then
        // `generateEmbedding('')` returned [] and the model failed inside the
        // transaction -> opaque 500 instead of a clear 400.
        offer: z.string({ required_error: 'Give is required' }).trim().min(1, 'Give is required'),
        want: z.string({ required_error: 'Get is required' }).trim().min(1, 'Get is required'),
        radius: z.number({ required_error: 'Radius is required' }).optional(),
        modality: z.enum(['physical', 'online']).optional(),
    }),
});

const updateBondRequestValidationSchema = z.object({
    body: z.object({
        isPause: z.boolean().optional(),
        // If sent, they can't be empty (same reason as in create).
        offer: z.string().trim().min(1).optional(),
        want: z.string().trim().min(1).optional(),
        radius: z.number().optional(),
        modality: z.enum(['physical', 'online']).optional(),
    }),
});

const bondRequestValidation = {
    createBondRequestValidationSchema,
    updateBondRequestValidationSchema,
};

export default bondRequestValidation;
