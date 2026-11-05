import { z } from 'zod';

// Fix: faltaba el wrapper `body:`, así que validateRequest (que parsea
// { body, cookies }) nunca validaba los campos reales → schema no-op.
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
