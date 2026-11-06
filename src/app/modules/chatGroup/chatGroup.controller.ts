/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import chatGroupServices from './chatGroup.service';
import { getCloudFrontUrl } from '../../helper/mutler-s3-uploader';
import { getSafeIO } from '../../helper/safeIO';
import { notifyGroupConversation } from '../../helper/notifyGroupConversation';

const createGroupChat = catchAsync(async (req, res) => {
    const file: any = req.files?.group_chat_image;
    if (req.files?.group_chat_image) {
        req.body.image = getCloudFrontUrl(file[0].key);
    }
    const result = await chatGroupServices.createGroupChat(
        req.user.profileId,
        req.body
    );
    // El chat nuevo aparece en la lista de TODOS los miembros sin refrescar.
    await notifyGroupConversation(getSafeIO(), result?._id);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Chat group created successfully',
        data: result,
    });
});
const updateGroupData = catchAsync(async (req, res) => {
    const file: any = req.files?.group_chat_image;
    if (req.files?.group_chat_image) {
        req.body.image = getCloudFrontUrl(file[0].key);
    }
    const result = await chatGroupServices.updateGroupData(
        req.user.profileId,
        req.params.id,
        req.body
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Chat group updated successfully',
        data: result,
    });
});
const addMember = catchAsync(async (req, res) => {
    const result = await chatGroupServices.addMember(
        req.user.profileId,
        req.params.id,
        req.body.memberId
    );
    // Solo al que entra: su lista lo recibe sin refrescar. Los que ya estaban no
    // necesitan que les mueva nada (y al que se saca no se le emite, ver helper).
    await notifyGroupConversation(getSafeIO(), result?._id, [
        String(req.body.memberId),
    ]);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Member added successfully',
        data: result,
    });
});
const removeMember = catchAsync(async (req, res) => {
    const result = await chatGroupServices.removeMember(
        req.user.profileId,
        req.params.id,
        req.body.memberId
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Member removed successfully',
        data: result,
    });
});

// El roster completo, sin la página de `get-chat-list`. `data` es un objeto
// pelado, como los demás handlers de esta ruta.
const getGroupMembers = catchAsync(async (req, res) => {
    const result = await chatGroupServices.getGroupMembers(
        req.user.profileId,
        req.params.id
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Chat group members retrieved successfully',
        data: result,
    });
});

const ChatGroupController = {
    createGroupChat,
    addMember,
    removeMember,
    updateGroupData,
    getGroupMembers,
};
export default ChatGroupController;
