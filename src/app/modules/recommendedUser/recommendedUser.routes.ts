import express from 'express';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';
import recommendedUserController from './recommendedUser.controller';

const router = express.Router();
// Requiere login: antes era público → cualquiera sin token dumpeaba la tabla
// (nombre/email/teléfono de terceros). Con auth + proyección sin PII (service).
router.get(
    '/get',
    auth(USER_ROLE.user),
    recommendedUserController.getRecommendedUsers
);

export const recommendedUserRoutes = router;
