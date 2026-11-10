import httpStatus from 'http-status';
import config from '../../config';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import { createToken } from '../user/user.utils';
import { TUserRole } from '../user/user.interface';
import {
    SOCKET_TOKEN_EXPIRES_IN,
    SOCKET_TOKEN_TTL_SECONDS,
    buildSocketTokenClaims,
} from '../../helper/socketToken';
import authServices from './auth.services';
import userServices from '../user/user.services';
import AppError from '../../error/appError';
import {
  clearAuthCookies,
  clearRefreshCookie,
  setAccessCookie,
  setAuthCookies,
  setRefreshCookie,
} from './refreshCookie';

// Refresh token contract: always in the HttpOnly cookie; also echoed in the JSON only
// when the native client asks via `x-client-type: native` (native apps can't use cookies).
const CLIENT_TYPE_HEADER = 'x-client-type';

// Exported for user.controller (verifyCode): any endpoint that can return a refresh
// token must go through here, or it leaks into the browser JSON.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const withRefreshTokenPolicy = (result: any, req: { headers: any }) => {
    if (!result || typeof result !== 'object') return result;
    const isNative =
        String(req.headers?.[CLIENT_TYPE_HEADER] ?? '').toLowerCase() ===
        'native';
    if (isNative) return result;
    // Browser: omit from JSON; the HttpOnly cookie already carries it.
    // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
    const { refreshToken: _omitted, ...rest } = result;
    return rest;
};

const loginUser = catchAsync(async (req, res) => {
  const result = await authServices.loginUserIntoDB(req.body);
  // Set access and refresh tokens as HttpOnly cookies for the browser
  if (result?.accessToken || result?.refreshToken) {
    setAuthCookies(res, {
      accessToken: result?.accessToken,
      refreshToken: result?.refreshToken,
    });
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User login successfully',
    data: withRefreshTokenPolicy(result, req),
  });
});
const changePassword = catchAsync(async (req, res) => {
  const { ...passwordData } = req.body;
  const result = await authServices.changePasswordIntoDB(
    req.user,
    passwordData,
  );

  // Changing the password updates passwordChangedAt, killing old tokens; the service
  // issues new ones, so set fresh cookies.
  if (result?.accessToken || result?.refreshToken) {
    setAuthCookies(res, {
      accessToken: result?.accessToken,
      refreshToken: result?.refreshToken,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Password is updated successfully',
    data: withRefreshTokenPolicy(result, req),
  });
});

const refreshToken = catchAsync(async (req, res) => {
  // Browser: HttpOnly `refreshToken` cookie. Mobile/other clients: token in body.
  // Cookie wins; body is the compatibility fallback.
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!token) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Refresh token is required');
  }
  const result = await authServices.refreshToken(token);
  // Also set the new access token as an HttpOnly cookie
  if (result?.accessToken) {
    setAccessCookie(res, result.accessToken);
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Access token is retrieved successfully',
    data: result,
  });
});

// B0 (bankybondy-v2): Socket.IO handshake token. Cookie-based browsers can't read the
// access token, and scope 'socket' is rejected by the HTTP API, so it opens no API.
const socketToken = catchAsync(async (req, res) => {
    const claims = buildSocketTokenClaims(req.user);
    if (!claims) {
        throw new AppError(
            httpStatus.UNAUTHORIZED,
            'Your session is missing its profile. Please log in again.',
            // Same code as `auth.ts` when profileId is unusable: the session is dead,
            // so the client must log out instead of retrying.
            'PROFILE_MISSING'
        );
    }
    const token = createToken(
        // Type-only cast: `req.user` comes from JwtPayload (role: string) while
        // `createToken` declares TUserRole; the value is the fresh role from the DB.
        { ...claims, role: claims.role as TUserRole },
        config.jwt_access_secret as string,
        SOCKET_TOKEN_EXPIRES_IN
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Socket token retrieved successfully',
        data: { token, expiresIn: SOCKET_TOKEN_TTL_SECONDS },
    });
});

// Logout: clears the HttpOnly cookies (browser JS can't). Idempotent and public.
const logoutUser = catchAsync(async (req, res) => {
  clearAuthCookies(res);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Logged out successfully',
    data: null,
  });
});
const forgetPassword = catchAsync(async (req, res) => {
  const email = req.body.email;
  const result = await authServices.forgetPassword(email);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    // Conditionally worded on purpose (anti-enumeration): never confirms the account.
    message: 'Si esa cuenta existe, te enviamos un código para restablecer tu contraseña.',
    data: result,
  });
});

const resetPassword = catchAsync(async (req, res) => {
  const result = await authServices.resetPassword(req.body);
  // Set session HttpOnly cookies for the browser
  if (result?.accessToken || result?.refreshToken) {
    setAuthCookies(res, {
      accessToken: result?.accessToken,
      refreshToken: result?.refreshToken,
    });
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Password reset successfully',
    data: withRefreshTokenPolicy(result, req),
  });
});
const verifyResetOtp = catchAsync(async (req, res) => {
  const result = await authServices.verifyResetOtp(
    req.body.email,
    req.body.resetCode,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Reset code verified',
    data: result,
  });
});

const resendResetCode = catchAsync(async (req, res) => {
  const result = await authServices.resendResetCode(req?.body.email);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    // Conditional on purpose, same as forgetPassword.
    message: 'Si esa cuenta existe, te reenviamos el código.',
    data: result,
  });
});
const resendVerifyCode = catchAsync(async (req, res) => {
  const result = await authServices.resendVerifyCode(req?.body.email);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Verify code resend successfully',
    data: result,
  });
});

const oAuthLogin = catchAsync(async (req, res) => {
  const { provider, token, role } = req.body;
  if (!['google', 'apple', 'facebook'].includes(provider)) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Invalid provider');
  }
  const result = await authServices.loginWithOAuth(provider, token, role);
  if (result?.accessToken || result?.refreshToken) {
    setAuthCookies(res, {
      accessToken: result?.accessToken,
      refreshToken: result?.refreshToken,
    });
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User login successfully',
    data: withRefreshTokenPolicy(result, req),
  });
});

// Current session's profile (name, contact, image, ...). The access token only
// carries id/profileId/email/role, so clients cannot render a profile without this.
const getMe = catchAsync(async (req, res) => {
  const result = await userServices.getMyProfile(req.user);

  if (!result) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      'Profile not found for the current session',
      'PROFILE_MISSING'
    );
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Profile retrieved successfully',
    data: result,
  });
});

const authControllers = {
  loginUser,
  changePassword,
  refreshToken,
  socketToken,
  logoutUser,
  forgetPassword,
  resetPassword,
  verifyResetOtp,
  resendResetCode,
  resendVerifyCode,
  oAuthLogin,
  getMe,
};

export default authControllers;
