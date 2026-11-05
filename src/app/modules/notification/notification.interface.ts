import { Types } from 'mongoose';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';

export interface INotification {
    title: string;
    message: string;
    seenBy?: Types.ObjectId[];
    receiver: string;
    type: (typeof ENUM_NOTIFICATION_TYPE)[keyof typeof ENUM_NOTIFICATION_TYPE];
    redirectId?: string;
    deleteBy?: Types.ObjectId[];
    // Firmas de match ya avisadas (solo MATCH): evita re-marcar no-leída una notif
    // por una firma que reaparece. Ver notification.model.ts / matching.notify.ts.
    notifiedSignatures?: string[];
}
