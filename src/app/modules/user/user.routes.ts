import { Router } from 'express';
import auth from '../../middlewares/auth';
import { authLimiter } from '../../middlewares/rateLimiter';
import validateRequest from '../../middlewares/validateRequest';
import normalUserValidations from '../normalUser/normalUser.validation';
import { USER_ROLE } from './user.constant';
import userControllers from './user.controller';
import userValidations from './user.validation';

const router = Router();

// SEGURIDAD (P0/P1): estas tres rutas son PÚBLICAS y emiten/consumen el OTP de
// 6 dígitos (verificación de alta). Sin rate limit, el código era
// brute-forceable dentro de su ventana y el registro/reenvío podían spamear
// mails. Se les aplica el mismo authLimiter que ya usan las rutas de /auth
// (login, forget/reset). NOTA (pendiente 2da tanda): sumar contador de intentos
// + lockout por cuenta e invalidar el código tras N fallos.
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

router.get(
    '/get-my-profile',
    auth(USER_ROLE.user, USER_ROLE.superAdmin),
    userControllers.getMyProfile
);

export const userRoutes = router;
