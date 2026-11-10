import { z } from 'zod';

// Loose validation of the search term. Optional: if missing or too short, the service
// returns empty lists without querying the DB.
export const globalSearchValidationSchema = z.object({
    query: z
        .object({
            q: z.string().optional(),
        })
        .optional(),
});

const SearchValidations = {
    globalSearchValidationSchema,
};

export default SearchValidations;
