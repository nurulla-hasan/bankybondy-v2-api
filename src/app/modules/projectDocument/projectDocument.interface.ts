import { Types } from 'mongoose';
type ObjectId = Types.ObjectId;

export interface IProjectDocument {
    id: ObjectId;
    addedBy: ObjectId;
    project: ObjectId;
    document_url: string;
    createdAt: Date;
    updatedAt: Date;
}
