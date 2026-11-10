import express from 'express';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';
import recommendedUserController from './recommendedUser.controller';

const router = express.Router();
// Login required: it used to be public, letting anyone dump the table
// (third-party name/email/phone). Now auth + PII-free projection in the service.
router.get(
    '/get',
    auth(USER_ROLE.user),
    recommendedUserController.getRecommendedUsers
);

export const recommendedUserRoutes = router;
