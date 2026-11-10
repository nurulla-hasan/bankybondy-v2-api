import { Types } from 'mongoose';
type ObjectId = Types.ObjectId;
import { ENUM_CONVERSATION_TYPE } from './conversation.enum';

export interface IConversation {
    id: ObjectId;
    participants: ObjectId[];
    lastMessage: ObjectId;
    type: (typeof ENUM_CONVERSATION_TYPE)[keyof typeof ENUM_CONVERSATION_TYPE];
    bondLink: ObjectId | null;
    chatGroup: ObjectId | null;
    // Participants who soft-hid this conversation for themselves only; the other side keeps its data.
    hiddenBy: ObjectId[];
    createdAt: Date;
    updatedAt: Date;
}
