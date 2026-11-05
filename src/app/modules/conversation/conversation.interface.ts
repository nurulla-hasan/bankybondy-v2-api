import { Types } from 'mongoose';
type ObjectId = Types.ObjectId;
import { ENUM_CONVERSATION_TYPE } from './conversation.enum';

export interface IConversation {
    id: ObjectId;
    participants: ObjectId[];
    lastMessage: ObjectId;
    type: (typeof ENUM_CONVERSATION_TYPE)[keyof typeof ENUM_CONVERSATION_TYPE];
    institution: ObjectId | null;
    project: ObjectId | null;
    bondLink: ObjectId | null;
    chatGroup: ObjectId | null;
    // B.7 (Tanda 2): participantes que ocultaron esta conversacion SOLO para si
    // mismos (soft-hide). No borra datos del otro participante.
    hiddenBy: ObjectId[];
    createdAt: Date;
    updatedAt: Date;
}
