import { Schema, model } from 'mongoose';
import { IConversation } from './conversation.interface'; // Importing the interface
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
        institution: {
            type: Schema.Types.ObjectId,
            ref: 'Institution',
            default: null,
        },
        project: {
            type: Schema.Types.ObjectId,
            ref: 'Project',
            default: null,
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
        // B.7 (Tanda 2): soft-hide por participante. Cada usuario que oculta la
        // conversacion agrega su propio id aca; el listado la excluye para el,
        // pero sigue visible para el otro participante (no se borran datos).
        hiddenBy: {
            type: [Schema.Types.ObjectId],
            ref: 'NormalUser',
            default: [],
        },
    },
    { timestamps: true }
);

// Las conversaciones se listan/consultan por participante y por bondLink. Sin
// indices eran COLLSCAN en cada listado de mensajes/vinculos.
conversationSchema.index({ participants: 1, updatedAt: -1 });
conversationSchema.index({ bondLink: 1 });

const Conversation = model<IConversation>('Conversation', conversationSchema);

export default Conversation;
