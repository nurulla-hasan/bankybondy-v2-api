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
// Ruta /google-login ELIMINADA por seguridad: aceptaba un email sin verificar
// (bypass de autenticacion / account takeover). El login con Google va por
// /oauth-login, que SI verifica el idToken de Google.
router.post(
    '/change-password',
    auth(USER_ROLE.user, USER_ROLE.admin, USER_ROLE.superAdmin),
    validateRequest(authValidations.changePasswordValidationSchema),
    authControllers.changePassword
);
// Sin auth(): un access token VENCIDO no puede pasar el middleware, y refrescar
// es justo lo que se necesita cuando venció. La autenticación la da el propio
// refresh token (se verifica en el service con el refresh secret + estado del
// usuario). Antes exigía auth() → el refresh era inalcanzable tras la expiración.
router.post(
    '/refresh-token',
    validateRequest(authValidations.refreshTokenValidationSchema),
    authControllers.refreshToken
);

// Logout: borra la cookie HttpOnly del refresh token. Público (idempotente).
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
