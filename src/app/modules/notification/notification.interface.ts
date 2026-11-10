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
    // Match signatures already notified (MATCH only): prevents re-marking a
    // notification unread when a signature reappears. See matching.notify.ts.
    notifiedSignatures?: string[];
}
