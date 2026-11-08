import { z } from 'zod';

const createBondRequestValidationSchema = z.object({
    body: z.object({
        // `.trim().min(1)`: un offer/want vacío pasaba la validación, y luego
        // `generateEmbedding('')` devolvía [] → el modelo (vector length>0) fallaba
        // dentro de la transacción → 500 opaco en vez de un 400 claro.
        offer: z.string({ required_error: 'Give is required' }).trim().min(1, 'Give is required'),
        want: z.string({ required_error: 'Get is required' }).trim().min(1, 'Get is required'),
        radius: z.number({ required_error: 'Radius is required' }).optional(),
        modality: z.enum(['physical', 'online']).optional(),
    }),
});

const updateBondRequestValidationSchema = z.object({
    body: z.object({
        isPause: z.boolean().optional(),
        // Si se envían, no pueden quedar vacíos (mismo motivo que en create).
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
