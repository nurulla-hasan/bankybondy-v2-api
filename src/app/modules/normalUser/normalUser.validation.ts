import { z } from 'zod';
import { ENUM_GENDER } from '../user/user.enum';

export const createNormalUserSchema = z.object({
    body: z.object({
        password: z
            .string({ required_error: 'Password is required' })
            .min(6, { message: 'Password must be at least 6 characters' }),
        confirmPassword: z
            .string({ required_error: 'Confirm password is required' })
            .min(6, { message: 'Password must be at least 6 characters' }),
        name: z.string({
            required_error: 'Name is required',
            invalid_type_error: 'Name must be a string',
        }),
        email: z.string().email('Invalid email format'),
        phone: z.string().optional(),
        profile_image: z.string().optional(),
        cover_image: z.string().optional(),
        gender: z
            .enum(Object.values(ENUM_GENDER) as [string, ...string[]])
            .optional(),
        dateOfBirth: z.string().optional(),
        address: z.string().optional(),
        bio: z.string().optional(),
    }),
});

export const updateNormalUserData = z.object({
    body: z.object({
        name: z.string().optional(),
        phone: z.string().optional(),
        profile_image: z.string().optional(),
        cover_image: z.string().optional(),
        gender: z
            .enum(Object.values(ENUM_GENDER) as [string, ...string[]])
            .optional(),
        dateOfBirth: z.string().optional(),
        address: z.string().optional(),
        bio: z.string().optional(),
        skills: z
            .array(z.string().regex(/^[0-9a-fA-F]{24}$/))
            .optional(),
        socialLinks: z.array(z.string().url()).optional(),
    }),
});

const subscriptionValidationSchema = z.object({
    body: z.object({
        type: z.enum(['Premium', 'Standard']),
        provider: z.enum(['paypal', 'mercadopago']).optional(),
    }),
});

// Palanca manual del plan (admin). A diferencia de la compra, acá SÍ se admite
// 'Free': es justamente la vía para revocar un plan ante un contracargo, y la
// única por la que un plan puede bajar. El motivo es opcional pero se pide en la
// UI: una palanca que mueve plata sin registro es peor que no tenerla.
const adminSetSubscriptionSchema = z.object({
    body: z.object({
        type: z.enum(['Free', 'Standard', 'Premium']),
        reason: z.string().max(500).optional(),
    }),
});

// Actualizacion de la geolocalizacion del usuario. lat/lng validados a rangos
// geograficos validos. `mode` opcional (default 'auto' en el servicio).
const updateLocationSchema = z.object({
    body: z.object({
        lat: z
            .number({ required_error: 'lat is required' })
            .min(-90, { message: 'lat must be >= -90' })
            .max(90, { message: 'lat must be <= 90' }),
        lng: z
            .number({ required_error: 'lng is required' })
            .min(-180, { message: 'lng must be >= -180' })
            .max(180, { message: 'lng must be <= 180' }),
        mode: z.enum(['auto', 'manual']).optional(),
    }),
});

const normalUserValidations = {
    createNormalUserSchema,
    updateNormalUserData,
    subscriptionValidationSchema,
    adminSetSubscriptionSchema,
    updateLocationSchema,
};

export default normalUserValidations;
