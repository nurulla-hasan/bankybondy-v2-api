import { Types } from 'mongoose';
type ObjectId = Types.ObjectId;

export interface IMessage {
    id: ObjectId;
    text: string;
    imageUrl: string[];
    videoUrl: string[];
    pdfUrl: string[];

    msgByUserId: ObjectId;
    seenBy: ObjectId[];
    conversationId: ObjectId;
    createdAt: Date;
    updatedAt: Date;
    isDeleted: boolean;
}
