import { Schema, model } from 'mongoose';
import { ENUM_FRIEND_REQUEST_STATUS } from './friendRequest.enum';
import { IFriendRequest } from './friendRequest.interface';

const FriendRequestSchema = new Schema<IFriendRequest>(
    {
        sender: {
            type: Schema.Types.ObjectId,
            ref: 'NormalUser',
            required: true,
        },
        receiver: {
            type: Schema.Types.ObjectId,
            ref: 'NormalUser',
            required: true,
        },
        status: {
            type: String,
            enum: Object.values(ENUM_FRIEND_REQUEST_STATUS),
            default: ENUM_FRIEND_REQUEST_STATUS.Pending,
        },
    },
    { timestamps: true }
);

FriendRequestSchema.index({ sender: 1 });
FriendRequestSchema.index({ receiver: 1 });
FriendRequestSchema.index({ status: 1 });

// At most ONE pending request per direction; the partial index closes the double-tap
// race the service's check-then-create can't. Accepted/Rejected leave the index,
// so the same pair can request again later.
FriendRequestSchema.index(
    { sender: 1, receiver: 1 },
    {
        unique: true,
        partialFilterExpression: {
            status: ENUM_FRIEND_REQUEST_STATUS.Pending,
        },
    }
);

const FriendRequest = model<IFriendRequest>(
    'FriendRequest',
    FriendRequestSchema
);
export default FriendRequest;
