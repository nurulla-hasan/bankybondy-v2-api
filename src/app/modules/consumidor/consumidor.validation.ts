import { z } from 'zod';
import { MEDIOS_PAGO, TIPOS_SOLICITUD } from './consumidor.model';

// Obligatorios SÓLO nombre y email: la Disp. 954/2025 prohíbe exigir "ningún otro
// trámite adicional". El resto ayuda a encontrar el pago, pero si falta, el
// pedido entra igual y se le pregunta después por mail (Disp. 3/2026: pasos
// razonables, por medios habituales, sólo para verificar identidad).
// Topes de longitud por la misma razón que en /contact-us: es un endpoint
// público que manda mails.
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
