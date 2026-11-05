import { Schema, model } from 'mongoose';

/* PEDIDOS DE "BOTÓN DE ARREPENTIMIENTO" Y "BOTÓN DE BAJA DE SERVICIO".
 *
 * Disposición SSDCyLC 954/2025 (derogó la Res. 424/2020 y la 316/2018): los dos
 * links tienen que funcionar SIN registración previa, y dentro de las 24 horas
 * hay que informar un código de identificación del pedido. Por eso esta colección
 * no cuelga de un usuario: la persona puede no tener sesión, o no tener cuenta.
 *
 * Es la PRUEBA ante un eventual sumario: cuándo se pidió (fecha del servidor) y
 * qué código se entregó. El pedido se guarda ANTES de mandar cualquier mail, y
 * no se borra: se marca `resuelta` a mano cuando se hizo la devolución o la baja.
 */

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
    // Si salió cada mail. El código ya se mostró en pantalla al crear el pedido,
    // así que un mail caído no incumple el plazo: queda anotado para saberlo.
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
