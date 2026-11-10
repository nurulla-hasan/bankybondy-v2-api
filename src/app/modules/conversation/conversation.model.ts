import { Schema, model } from 'mongoose';
import { IConversation } from './conversation.interface';
import { ENUM_CONVERSATION_TYPE } from './conversation.enum';

const conversationSchema = new Schema<IConversation>(
    {
        participants: {
            type: [Schema.Types.ObjectId],
            ref: 'NormalUser',
            required: true,
        },
        lastMessage: {
            type: Schema.Types.ObjectId,
            ref: 'Message',
            default: null,
        },
        type: {
            type: String,
            enum: Object.values(ENUM_CONVERSATION_TYPE),
            default: ENUM_CONVERSATION_TYPE.oneToOne,
            required: true,
        },
        bondLink: {
            type: Schema.Types.ObjectId,
            ref: 'BondLink',
            default: null,
        },
        chatGroup: {
            type: Schema.Types.ObjectId,
            ref: 'ChatGroup',
            default: null,
        },
        // B.7 (Tanda 2): per-participant soft hide. Each user who hides the
        // conversation adds their id here; it is excluded only for them.
        hiddenBy: {
            type: [Schema.Types.ObjectId],
            ref: 'NormalUser',
            default: [],
        },
    },
    { timestamps: true }
);

// Conversations are listed/queried by participant and by bondLink; without these
// indexes every listing was a COLLSCAN.
conversationSchema.index({ participants: 1, updatedAt: -1 });
conversationSchema.index({ bondLink: 1 });

const Conversation = model<IConversation>('Conversation', conversationSchema);

export default Conversation;
