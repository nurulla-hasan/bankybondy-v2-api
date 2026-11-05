import { model, Schema } from 'mongoose';
import { ENUM_BOND_LINK_STATUS } from './bondLink.enum';
import { IBondLink } from './bondLink.interface';

const BondLinkSchema = new Schema<IBondLink>(
    {
        name: { type: String, required: true },
        participants: [{ type: Schema.Types.ObjectId, ref: 'NormalUser' }],
        requestedBonds: [{ type: Schema.Types.ObjectId, ref: 'BondRequest' }],
        // Llave de idempotencia (ids de bonos ordenados+unicos, unidos por '_').
        // La escribe createBondLink; el indice unico parcial de abajo la usa.
        bondsKey: { type: String },
        status: {
            type: String,
            enum: Object.values(ENUM_BOND_LINK_STATUS),
            default: ENUM_BOND_LINK_STATUS.Ongoing,
        },
        markAsCompletedBy: {
            type: [Schema.Types.ObjectId],
            default: [],
        },
        // Recordatorio de cierre ya enviado (sweep). null/ausente = no avisado aún.
        reminderSentAt: {
            type: Date,
            default: null,
        },
    },
    { timestamps: true }
);

// `getMyBondLinks` consulta BondLink.find({participants: userId}) + count. Sin
// indice era un COLLSCAN que crecia con TODOS los vinculos del sistema (no los
// del usuario). Indice por participante + orden por recientes.
BondLinkSchema.index({ participants: 1, updatedAt: -1 });

// R2-6 — Idempotencia contra doble-submit: a lo sumo UN vinculo ACTIVO (Ongoing)
// por conjunto de bonos. Un doble-tap del front reenvia el mismo `requestedBonds`;
// sin esta llave se creaban DOS BondLink + DOS conversaciones. El indice es
// PARCIAL:
//  - `status: Ongoing`  → al pasar a Completed/Canceled el vinculo SALE del indice
//    y esos mismos bonos pueden volver a linkearse legitimamente en el futuro.
//  - `bondsKey: {$exists:true}` → los docs viejos (sin la llave) NO se indexan, asi
//    que el indice construye sin colisionar con datos previos (no requiere migracion).
// El service captura el E11000 y devuelve el vinculo existente (idempotente).
BondLinkSchema.index(
    { bondsKey: 1 },
    {
        unique: true,
        partialFilterExpression: {
            bondsKey: { $exists: true },
            status: ENUM_BOND_LINK_STATUS.Ongoing,
        },
    }
);

export const BondLink = model<IBondLink>('BondLink', BondLinkSchema);
