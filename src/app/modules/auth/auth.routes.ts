import { Router } from 'express';
import validateRequest from '../../middlewares/validateRequest';
import auth from '../../middlewares/auth';
import { authLimiter } from '../../middlewares/rateLimiter';
import authControllers from './auth.controller';
import { USER_ROLE } from '../user/user.constant';
import authValidations from './auth.validation';

const router = Router();

router.post(
    '/login',
    authLimiter,
    validateRequest(authValidations.loginValidationSchema),
    authControllers.loginUser
);
// /google-login removed for security: it accepted an unverified email (account
// takeover). Google login goes through /oauth-login, which verifies the idToken.
router.get(
    '/me',
    auth(USER_ROLE.user, USER_ROLE.admin, USER_ROLE.superAdmin),
    authControllers.getMe
);
router.post(
    '/change-password',
    auth(USER_ROLE.user, USER_ROLE.admin, USER_ROLE.superAdmin),
    validateRequest(authValidations.changePasswordValidationSchema),
    authControllers.changePassword
);
// No auth(): an expired access token could never pass it, and refreshing is exactly
// what's needed then. The refresh token itself authenticates (verified in the service).
router.post(
    '/refresh-token',
    validateRequest(authValidations.refreshTokenValidationSchema),
    authControllers.refreshToken
);

// B0: short-lived token for the Socket.IO handshake (the cookie-based front can't
// read the access token). Behind auth(): only logged-in users can mint it.
router.get(
    '/socket-token',
    auth(USER_ROLE.user),
    authControllers.socketToken
);

// Logout: clears the HttpOnly refresh token cookie. Public and idempotent.
router.post('/logout', authControllers.logoutUser);

router.post(
    '/forget-password',
    authLimiter,
    validateRequest(authValidations.forgetPasswordValidationSchema),
    authControllers.forgetPassword
);
router.post(
    '/reset-password',
    authLimiter,
    validateRequest(authValidations.resetPasswordValidationSchema),
    authControllers.resetPassword
);
router.post(
    '/verify-reset-otp',
    authLimiter,
    validateRequest(authValidations.verifyResetOtpValidationSchema),
    authControllers.verifyResetOtp
);

router.post(
    '/resend-reset-code',
    authLimiter,
    validateRequest(authValidations.resendResetCodeValidationSchema),
    authControllers.resendResetCode
);

router.post(
    '/resend-verify-code',
    authLimiter,
    validateRequest(authValidations.resendResetCodeValidationSchema),
    authControllers.resendVerifyCode
);

router.post('/oauth-login', authLimiter, authControllers.oAuthLogin);

export const authRoutes = router;
