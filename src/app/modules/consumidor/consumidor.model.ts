import { Schema, model } from 'mongoose';

/* "Regret button" and "cancel service" requests (SSDCyLC 954/2025): both must work
 * without login, so this does not hang off a user. Kept as proof of when and what code was issued. */

export const TIPOS_SOLICITUD = ['arrepentimiento', 'baja'] as const;
export type TipoSolicitud = (typeof TIPOS_SOLICITUD)[number];

export const MEDIOS_PAGO = ['paypal', 'mercadopago', 'otro'] as const;

export interface ISolicitudConsumidor {
    codigo: string;
    tipo: TipoSolicitud;
    nombre: string;
    email: string;
    medioPago?: (typeof MEDIOS_PAGO)[number];
    operacion?: string;
    comentario?: string;
    idioma: 'es' | 'en';
    estado: 'recibida' | 'resuelta';
    // Mail delivery flags: the code was already shown on screen at creation,
    // so a failed mail does not breach the deadline; it's just recorded.
    mailConsumidor?: boolean;
    mailAdmin?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
}

const SolicitudConsumidorSchema = new Schema<ISolicitudConsumidor>(
    {
        codigo: { type: String, required: true, unique: true },
        tipo: { type: String, enum: TIPOS_SOLICITUD, required: true },
        nombre: { type: String, required: true },
        email: { type: String, required: true, index: true },
        medioPago: { type: String, enum: MEDIOS_PAGO },
        operacion: { type: String },
        comentario: { type: String },
        idioma: { type: String, enum: ['es', 'en'], default: 'es' },
        estado: {
            type: String,
            enum: ['recibida', 'resuelta'],
            default: 'recibida',
        },
        mailConsumidor: { type: Boolean },
        mailAdmin: { type: Boolean },
    },
    { timestamps: true }
);

export const SolicitudConsumidor = model<ISolicitudConsumidor>(
    'SolicitudConsumidor',
    SolicitudConsumidorSchema
);
