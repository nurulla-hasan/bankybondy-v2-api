import { Schema, model } from 'mongoose';
import { IMessage } from './message.interface';

const messageSchema = new Schema<IMessage>(
    {
        text: {
            type: String,
            default: '',
        },
        imageUrl: {
            type: [String],
            default: [],
        },
        videoUrl: {
            type: [String],
            default: [],
        },
        pdfUrl: {
            type: [String],
            default: [],
        },
        msgByUserId: {
            type: Schema.Types.ObjectId,
            ref: 'NormalUser',
            required: true,
        },
        seenBy: {
            type: [Schema.Types.ObjectId],
            ref: 'NormalUser',
            default: [],
        },
        conversationId: {
            type: Schema.Types.ObjectId,
            ref: 'Conversation',
            required: true,
        },
        isDeleted: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
    }
);

// Message list filters by conversationId and sorts by date.
messageSchema.index({ conversationId: 1, createdAt: -1 });

const Message = model<IMessage>('Message', messageSchema);

export default Message;
