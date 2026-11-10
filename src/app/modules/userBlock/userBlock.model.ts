import { model, Schema } from 'mongoose';
import { IUserBlock } from './userBlock.interface';

const userBlockSchema = new Schema<IUserBlock>(
    {
        blocker: {
            type: Schema.Types.ObjectId,
            ref: 'NormalUser',
            required: true,
        },
        blocked: {
            type: Schema.Types.ObjectId,
            ref: 'NormalUser',
            required: true,
        },
    },
    {
        timestamps: true,
    }
);

// A user cannot block the same target twice (unique pair).
userBlockSchema.index({ blocker: 1, blocked: 1 }, { unique: true });
// "Who blocked me" queries.
userBlockSchema.index({ blocked: 1 });

const UserBlock = model<IUserBlock>('UserBlock', userBlockSchema);

export default UserBlock;
