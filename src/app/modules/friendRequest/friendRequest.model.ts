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

// A lo sumo UNA solicitud PENDING por dirección (sender→receiver). Cierra la
// carrera pura de doble-tap que el chequeo check-then-create del service no puede
// (dos requests concurrentes pasan el findOne y crean dos). Índice PARCIAL sobre
// status:Pending: al pasar a Accepted/Rejected la solicitud SALE del índice, así
// que un mismo par puede volver a solicitarse legítimamente en el futuro. El
// service captura el E11000 y responde "Request already exists". (Verificado
// 23-jul con dedupeFriendRequests.js: 0 duplicados PENDING en la base → construye
// limpio, sin migración.)
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
