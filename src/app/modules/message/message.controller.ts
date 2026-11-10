import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import AppError from '../../error/appError';
import { createOneToOneMessage } from '../../helper/createOneToOneMessage';
import { markSeen } from '../../helper/markSeen';
import { notifyMessageDeletion } from '../../helper/notifyMessageDeletion';
import { getSafeIO } from '../../helper/safeIO';
import messageServices from './message.service';

const getMessages = catchAsync(async (req, res) => {
    const result = await messageServices.getMessages(
        req.user.profileId,
        req.query
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Message retrieved successfully',
        data: result,
    });
});

const deleteMessage = catchAsync(async (req, res) => {
    const result = await messageServices.deleteMessage(
        req.params.id,
        req.user.profileId
    );
    // Notify the other participants (best-effort, never breaks the response).
    await notifyMessageDeletion(getSafeIO(), result, req.user.profileId);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Message deleted successfully',
        data: result,
    });
});

const getUnreadCount = catchAsync(async (req, res) => {
    const result = await messageServices.getUnreadMessageCount(
        req.user.profileId
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Unread message count retrieved successfully',
        data: result,
    });
});

// HTTP twin of the socket `seen` event: same `markSeen`, same guards. Without it,
// marking as read required a live connection and badges stayed up after a drop.
const markSeenMessages = catchAsync(async (req, res) => {
    const result = await markSeen({
        conversationId: req.body?.conversationId,
        currentUserId: req.user.profileId,
        io: getSafeIO(),
    });
    if (result === 'invalid') {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid conversation id');
    }
    if (result === 'not_found') {
        throw new AppError(httpStatus.NOT_FOUND, 'Conversation not found');
    }
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Messages marked as seen',
        data: { marked: true },
    });
});

// HTTP twin of the socket 1-to-1 branch: same core, guards, write and events.
// Needed because with no live connection there was no way to send a message.
const sendMessage = catchAsync(async (req, res) => {
    const result = await createOneToOneMessage({
        currentUserId: req.user.profileId,
        receiver: req.body?.receiver,
        text: req.body?.text,
        imageUrl: req.body?.imageUrl,
        videoUrl: req.body?.videoUrl,
        pdfUrl: req.body?.pdfUrl,
        clientId: req.body?.clientId,
        io: getSafeIO(),
    });
    if (result.error) {
        throw new AppError(result.error.code, result.error.message);
    }
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Message sent successfully',
        data: result.message,
    });
});

const MessageController = {
    getMessages,
    deleteMessage,
    getUnreadCount,
    markSeenMessages,
    sendMessage,
};
export default MessageController;
