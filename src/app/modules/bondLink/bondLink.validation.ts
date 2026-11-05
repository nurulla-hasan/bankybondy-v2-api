import { z } from 'zod';

import { ENUM_BOND_LINK_STATUS } from './bondLink.enum';

export const createBondLinkSchema = z.object({
    body: z.object({
        // `.min(1)`: un nombre vacío pasaba la validación y el chat del trueque se
        // renderizaba con el fallback "Grupo" en el front. Se exige no vacío.
        name: z
            .string({ required_error: 'Name is required' })
            .trim()
            .min(1, 'Name is required'),
        participants: z
            .array(z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ObjectId'))
            .optional(),
        requestedBonds: z
            .array(z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ObjectId'))
            .optional(),
        status: z
            .enum(Object.values(ENUM_BOND_LINK_STATUS) as [string, ...string[]])
            .optional(),
    }),
});

// Rechazar: body opcional con los participantes a bloquear. El servicio filtra al
// propio usuario y valida que sean participantes del trueque.
export const rejectBondLinkSchema = z.object({
    body: z.object({
        blockUserIds: z
            .array(z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ObjectId'))
            .optional(),
    }),
});

const BondLinkValidations = { createBondLinkSchema, rejectBondLinkSchema };
export default BondLinkValidations;
