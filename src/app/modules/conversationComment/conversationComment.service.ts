import ConversationComment from './conversationComment.model';
import httpStatus from 'http-status';
import AppError from '../../error/appError';
import { IConversationComment } from './conversationComment.interface';

// Create
const create = async (payload: IConversationComment) => {
    return await ConversationComment.create(payload);
};

// Get All
const getAll = async () => {
    return await ConversationComment.find()
        .populate('institutionConversation')
        .populate('likers');
};

// Update (solo el autor)
const update = async (
    id: string,
    commentor: string,
    payload: Partial<IConversationComment>
) => {
    // No permitir cambiar el propietario vía payload
    const { commentor: _ignore, ...safePayload } = payload;
    const result = await ConversationComment.findOneAndUpdate(
        { _id: id, commentor },
        safePayload,
        { new: true }
    );
    if (!result)
        throw new AppError(
            httpStatus.NOT_FOUND,
            'Comment not found or not owned by you'
        );
    return result;
};

// Delete (solo el autor)
const remove = async (id: string, commentor: string) => {
    const result = await ConversationComment.findOneAndDelete({
        _id: id,
        commentor,
    });
    if (!result)
        throw new AppError(
            httpStatus.NOT_FOUND,
            'Comment not found or not owned by you'
        );
    return result;
};

const ConversationCommentService = {
    create,
    getAll,
    update,
    remove,
};

export default ConversationCommentService;
