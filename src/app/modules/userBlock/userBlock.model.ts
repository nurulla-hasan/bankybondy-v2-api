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

// Un usuario no puede bloquear dos veces al mismo (par unico).
userBlockSchema.index({ blocker: 1, blocked: 1 }, { unique: true });
// Consultas de "quienes me bloquearon a mi".
userBlockSchema.index({ blocked: 1 });

const UserBlock = model<IUserBlock>('UserBlock', userBlockSchema);

export default UserBlock;
