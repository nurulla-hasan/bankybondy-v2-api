import { z } from 'zod';

export const addRatingValidation = z.object({
    body: z.object({
        userId: z.string({ required_error: 'User id is required' }),
        bondLink: z.string({ required_error: 'Bond link id is required' }),
        rating: z
            .number({ required_error: 'Rating is required' })
            .int() // estrellas enteras: un 4.73 sesgaba el promedio de reputación
            .min(1)
            .max(5),
        // D.3 (Tanda 2): comentario breve opcional (max 500 chars).
        comment: z.string().trim().max(500).optional(),
    }),
});

const BondRatingValidations = { addRatingValidation };
export default BondRatingValidations;
