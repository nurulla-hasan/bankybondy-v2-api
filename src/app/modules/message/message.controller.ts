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
    // Avisar a los demás participantes (best-effort, nunca rompe la respuesta).
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

// El gemelo HTTP del evento `seen` del socket: mismo `markSeen`, mismas guardas.
// Sin esto, marcar como leído dependía de tener una conexión viva — y tras un
// corte el badge no se bajaba aunque el usuario hubiera leído todo.
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

// El gemelo HTTP de la rama 1-a-1 del socket: mismo núcleo, mismos guardas, misma
// escritura y mismos eventos. Hace falta porque sin conexión viva (socket caído,
// app en segundo plano) no había ninguna forma de mandar un mensaje.
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
