import { z } from 'zod';

export const addRatingValidation = z.object({
    body: z.object({
        userId: z.string({ required_error: 'User id is required' }),
        bondLink: z.string({ required_error: 'Bond link id is required' }),
        rating: z
            .number({ required_error: 'Rating is required' })
            .int() // whole stars: 4.73 would skew the reputation average
            .min(1)
            .max(5),
        // Optional short comment (max 500 chars).
        comment: z.string().trim().max(500).optional(),
    }),
});

const BondRatingValidations = { addRatingValidation };
export default BondRatingValidations;
