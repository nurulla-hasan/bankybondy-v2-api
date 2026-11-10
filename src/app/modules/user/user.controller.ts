import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import userServices from './user.services';
import {
    clearAuthCookies,
    clearRefreshCookie,
    setAuthCookies,
    setRefreshCookie,
} from '../auth/refreshCookie';
import { withRefreshTokenPolicy } from '../auth/auth.controller';

const registerUser = catchAsync(async (req, res) => {
    const result = await userServices.registerUser(req.body);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message:
            'User registration successful.Check email for verify your email',
        data: result,
    });
});
const verifyCode = catchAsync(async (req, res) => {
    const result = await userServices.verifyCode(
        req?.body?.email,
        req?.body?.verifyCode
    );
    // Verification starts a session: set access + refresh cookies for the browser.
    if ((result as any)?.accessToken || (result as any)?.refreshToken) {
        setAuthCookies(res, {
            accessToken: (result as any)?.accessToken,
            refreshToken: (result as any)?.refreshToken,
        });
    }
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Successfully verified your account with email',
        data: withRefreshTokenPolicy(result, req),
    });
});
const resendVerifyCode = catchAsync(async (req, res) => {
    const result = await userServices.resendVerifyCode(req?.body?.email);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Verify code send to your email inbox',
        data: result,
    });
});

const getMyProfile = catchAsync(async (req, res) => {
    const result = await userServices.getMyProfile(req.user);

    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Successfully retrieved your data',
        data: result,
    });
});
const changeUserStatus = catchAsync(async (req, res) => {
    const result = await userServices.changeUserStatus(req.params.id);

    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: `User is ${result?.isBlocked ? 'Blocked' : 'Unblocked'}`,
        data: result,
    });
});
const deleteUserAccount = catchAsync(async (req, res) => {
    const result = await userServices.deleteUserAccount(
        req.user,
        req.body.password
    );
    // Clear the refresh cookie since the account is gone. Always a self-delete,
    // so this never logs out a third party.
    clearRefreshCookie(res);

    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: `Your account deleted successfully`,
        data: result,
    });
});

const userController = {
    registerUser,
    verifyCode,
    resendVerifyCode,
    getMyProfile,
    changeUserStatus,
    deleteUserAccount,
};
export default userController;
