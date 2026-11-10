import { model, Schema } from 'mongoose';
import { IChatGroup } from './chatGroup.interface';

const chatGroupSchema = new Schema<IChatGroup>(
    {
        // `required` + `trim`: a nameless ChatGroup rendered as "Grupo" (front
        // fallback), so no new group can lack a name. Old docs are unaffected.
        name: {
            type: String,
            required: true,
            trim: true,
        },
        participants: {
            type: [Schema.Types.ObjectId],
            ref: 'NormalUser',
            required: true,
        },
        creator: {
            type: Schema.Types.ObjectId,
            // Was 'NomralUser' (typo). `ref` is schema metadata used only for
            // populate and never persisted, so the first `.populate('creator')`
            // threw MissingSchemaError -> 500. No migration needed.
            ref: 'NormalUser',
            required: true,
        },
        image: {
            type: String,
            default: '',
        },
    },
    { timestamps: true }
);

const ChatGroup = model<IChatGroup>('ChatGroup', chatGroupSchema);
export default ChatGroup;
