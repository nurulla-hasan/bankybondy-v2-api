import { Router } from 'express';
import auth from '../../middlewares/auth';
import { authLimiter } from '../../middlewares/rateLimiter';
import validateRequest from '../../middlewares/validateRequest';
import normalUserValidations from '../normalUser/normalUser.validation';
import { USER_ROLE } from './user.constant';
import userControllers from './user.controller';
import userValidations from './user.validation';

const router = Router();

// SECURITY (P0/P1): these three routes are PUBLIC and issue/consume the 6-digit
// OTP, so without a rate limit the code was brute-forceable and register/resend
// could spam emails. They use the same authLimiter as /auth. TODO: add per-account
// attempt counter + lockout and invalidate the code after N failures.
router.post(
    '/register-user',
    authLimiter,
    validateRequest(normalUserValidations.createNormalUserSchema),
    userControllers.registerUser
);

router.post(
    '/verify-code',
    authLimiter,
    validateRequest(userValidations.verifyCodeValidationSchema),
    userControllers.verifyCode
);

router.post(
    '/resend-verify-code',
    authLimiter,
    validateRequest(userValidations.resendVerifyCodeSchema),
    userControllers.resendVerifyCode
);

router.get(
    '/get-my-profile',
    auth(USER_ROLE.user, USER_ROLE.admin, USER_ROLE.superAdmin),
    userControllers.getMyProfile
);

router.patch(
    '/block-unblock/:id',
    auth(USER_ROLE.superAdmin),
    userControllers.changeUserStatus
);
router.delete(
    '/delete-account',
    auth(USER_ROLE.user),
    validateRequest(userValidations.deleteUserAccountValidationSchema),
    userControllers.deleteUserAccount
);

export const userRoutes = router;
