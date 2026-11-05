import { model, Schema } from 'mongoose';
import { INotification } from './notification.interface';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';

const notificationSchema = new Schema<INotification>(
    {
        title: {
            type: String,
            required: true,
        },
        message: {
            type: String,
            required: true,
        },
        seenBy: {
            type: [Schema.Types.ObjectId],
            default: [],
        },
        receiver: {
            type: String,
            required: true,
        },
        type: {
            type: String,
            enum: Object.values(ENUM_NOTIFICATION_TYPE),
            required: true,
        },
        redirectId: {
            type: String,
            default: null,
        },
        deleteBy: {
            type: [Schema.Types.ObjectId],
            default: [],
        },
        // Firmas de match (bonds ordenados unidos por '|') por las que YA se avisó
        // en esta notif colapsada de MATCH. Evita "rebotar" (volver a no-leída) por
        // una firma que reaparece por churn (contraparte pausa/vuelve, shuffle del
        // top-100): sólo se rebota ante firmas GENUINAMENTE nuevas. Sólo MATCH.
        notifiedSignatures: {
            type: [String],
            default: [],
        },
    },

    {
        timestamps: true,
    }
);

// Indice: el badge/listado filtra por receiver y ordena por fecha.
notificationSchema.index({ receiver: 1, createdAt: -1 });

const Notification = model<INotification>('Notification', notificationSchema);

export default Notification;
