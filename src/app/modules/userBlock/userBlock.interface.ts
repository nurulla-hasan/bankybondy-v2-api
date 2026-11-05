import { Types } from 'mongoose';

export interface IUserBlock {
    // Quien bloquea.
    blocker: Types.ObjectId;
    // A quien bloquea.
    blocked: Types.ObjectId;
    createdAt?: Date;
    updatedAt?: Date;
}
