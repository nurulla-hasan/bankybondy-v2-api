import express from 'express';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';
import userBlockController from './userBlock.controller';

const router = express.Router();

// Block a user (by NormalUser profile id).
router.post(
    '/block/:id',
    auth(USER_ROLE.user),
    userBlockController.blockUser
);

// Unblock a user.
router.delete(
    '/unblock/:id',
    auth(USER_ROLE.user),
    userBlockController.unblockUser
);

// List the users I blocked.
router.get(
    '/my-blocked-users',
    auth(USER_ROLE.user),
    userBlockController.getMyBlockedUsers
);

export const userBlockRoutes = router;
