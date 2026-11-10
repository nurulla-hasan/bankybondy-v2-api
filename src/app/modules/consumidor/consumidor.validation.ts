import { z } from 'zod';
import { MEDIOS_PAGO, TIPOS_SOLICITUD } from './consumidor.model';

// Only nombre and email are required: Disp. 954/2025 bans extra paperwork. The
// rest helps locate the payment but is asked later by email if missing.
// Length caps for the same reason as /contact-us: public endpoint that sends mail.
const crearSolicitudSchema = z.object({
    body: z.object({
        tipo: z.enum(TIPOS_SOLICITUD),
        nombre: z
            .string({ required_error: 'Name is required' })
            .trim()
            .min(1, 'Name is required')
            .max(100, 'Name is too long'),
        email: z
            .string({ required_error: 'Email is required' })
            .trim()
            .email('Invalid email')
            .max(254, 'Email is too long'),
        medioPago: z.enum(MEDIOS_PAGO).optional(),
        operacion: z.string().trim().max(100).optional(),
        comentario: z.string().trim().max(2000).optional(),
        idioma: z.enum(['es', 'en']).optional(),
    }),
});

export const ConsumidorValidations = {
    crearSolicitudSchema,
};
