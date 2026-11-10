import { z } from 'zod';

// The `body:` wrapper was missing, so validateRequest (which parses { body, cookies })
// never validated the real fields and the schema was a no-op.
export const updateSuperAdminSchema = z.object({
    body: z.object({
        name: z.string().optional(),
        email: z
            .string()
            .email('Invalid email format')
            .nonempty('Email is required')
            .optional(),
        profile_image: z.string().optional().default(''),
    }),
});

const superAdminValidations = {
    updateSuperAdminSchema,
};

export default superAdminValidations;
