import { Types } from 'mongoose';

export interface IUserBlock {
    // Blocker.
    blocker: Types.ObjectId;
    // Blocked user.
    blocked: Types.ObjectId;
    createdAt?: Date;
    updatedAt?: Date;
}
