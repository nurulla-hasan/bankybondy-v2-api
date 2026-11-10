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
        // Match signatures (sorted bond ids joined by '|') already notified in this
        // collapsed MATCH notification: stops a signature reappearing due to churn
        // from bouncing it back to unread. Only genuinely new ones bounce. MATCH only.
        notifiedSignatures: {
            type: [String],
            default: [],
        },
    },

    {
        timestamps: true,
    }
);

// Listing/badge filters by receiver and sorts by date.
notificationSchema.index({ receiver: 1, createdAt: -1 });

const Notification = model<INotification>('Notification', notificationSchema);

export default Notification;
