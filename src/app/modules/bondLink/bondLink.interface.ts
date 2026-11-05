import { Types } from 'mongoose';
import { ENUM_BOND_LINK_STATUS } from './bondLink.enum';

export interface IBondLink {
    id: Types.ObjectId;
    name: string;
    participants: Types.ObjectId[];
    requestedBonds: Types.ObjectId[];
    // Llave de idempotencia: hash determinista (ids de bonos ordenados y unicos,
    // unidos por '_'). Un indice unico parcial sobre {bondsKey, status:Ongoing}
    // impide que un doble-submit cree DOS vinculos activos con el mismo conjunto
    // de bonos. Opcional: los docs viejos (previos a esta version) no lo tienen.
    bondsKey?: string;
    status: (typeof ENUM_BOND_LINK_STATUS)[keyof typeof ENUM_BOND_LINK_STATUS];
    markAsCompletedBy: Types.ObjectId[];
    // Recordatorio de cierre ya enviado (para no re-avisar): lo setea el sweep al
    // nudgear a los que no completaron un trueque viejo Ongoing.
    reminderSentAt?: Date;
    createdAt: Date;
    updated: Date;
}
