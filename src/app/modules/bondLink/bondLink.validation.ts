import { z } from 'zod';

import { ENUM_BOND_LINK_STATUS } from './bondLink.enum';

export const createBondLinkSchema = z.object({
    body: z.object({
        // Non-empty on purpose: an empty name passed before and the chat fell back to "Grupo".
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

// Reject: optional body with the participants to block. The service drops the caller
// and validates the ids belong to the trade.
export const rejectBondLinkSchema = z.object({
    body: z.object({
        blockUserIds: z
            .array(z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ObjectId'))
            .optional(),
    }),
});

const BondLinkValidations = { createBondLinkSchema, rejectBondLinkSchema };
export default BondLinkValidations;
