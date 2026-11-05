import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
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

const MessageController = { getMessages, deleteMessage, getUnreadCount };
export default MessageController;
