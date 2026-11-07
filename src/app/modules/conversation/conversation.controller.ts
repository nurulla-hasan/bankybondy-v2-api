import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import ConversationService from './conversation.service';

const getChatList = catchAsync(async (req, res) => {
    const result = await ConversationService.getConversation(
        req?.user?.profileId,
        req.query
    );

    sendResponse(res, {
        statusCode: 201,
        success: true,
        message: 'Conversation retrieved successfully',
        data: result,
    });
});

const getHiddenChatList = catchAsync(async (req, res) => {
    const result = await ConversationService.getHiddenConversations(
        req?.user?.profileId,
        req.query
    );

    sendResponse(res, {
        statusCode: 200,
        success: true,
        message: 'Hidden conversations retrieved successfully',
        data: result,
    });
});

const getConversationMediaFiles = catchAsync(async (req, res) => {
    const result = await ConversationService.getConversationMediaFiles(
        req?.user?.profileId,
        req.params.id,
        req.query
    );

    sendResponse(res, {
        statusCode: 200,
        success: true,
        message: 'Media files retrieved successfully',
        data: result,
    });
});

// B.7 (Tanda 2): ocultar una conversacion solo para el usuario actual.
const hideConversation = catchAsync(async (req, res) => {
    const result = await ConversationService.setConversationHidden(
        req?.user?.profileId,
        req.params.id,
        true
    );
    sendResponse(res, {
        statusCode: 200,
        success: true,
        message: 'Conversation hidden successfully',
        data: result,
    });
});

// B.7 (Tanda 2): des-ocultar (revertir) una conversacion para el usuario actual.
const unhideConversation = catchAsync(async (req, res) => {
    const result = await ConversationService.setConversationHidden(
        req?.user?.profileId,
        req.params.id,
        false
    );
    sendResponse(res, {
        statusCode: 200,
        success: true,
        message: 'Conversation unhidden successfully',
        data: result,
    });
});

const ConversationController = {
    getChatList,
    getHiddenChatList,
    getConversationMediaFiles,
    hideConversation,
    unhideConversation,
};

export default ConversationController;
