import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import userBlockServices from './userBlock.service';

const blockUser = catchAsync(async (req, res) => {
    const result = await userBlockServices.blockUser(
        req.user.profileId,
        req.params.id
    );
    sendResponse(res, {
        statusCode: httpStatus.CREATED,
        success: true,
        message: 'User blocked successfully',
        data: result,
    });
});

const unblockUser = catchAsync(async (req, res) => {
    const result = await userBlockServices.unblockUser(
        req.user.profileId,
        req.params.id
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'User unblocked successfully',
        data: result,
    });
});

const getMyBlockedUsers = catchAsync(async (req, res) => {
    const result = await userBlockServices.getMyBlockedUsers(
        req.user.profileId,
        req.query
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Blocked users retrieved successfully',
        data: result,
    });
});

const userBlockController = {
    blockUser,
    unblockUser,
    getMyBlockedUsers,
};

export default userBlockController;
