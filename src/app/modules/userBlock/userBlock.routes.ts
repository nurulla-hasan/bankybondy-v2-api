import express from 'express';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';
import userBlockController from './userBlock.controller';

const router = express.Router();

// Bloquear a un usuario (por id de perfil NormalUser).
router.post(
    '/block/:id',
    auth(USER_ROLE.user),
    userBlockController.blockUser
);

// Desbloquear a un usuario.
router.delete(
    '/unblock/:id',
    auth(USER_ROLE.user),
    userBlockController.unblockUser
);

// Listar los usuarios que YO bloquee.
router.get(
    '/my-blocked-users',
    auth(USER_ROLE.user),
    userBlockController.getMyBlockedUsers
);

export const userBlockRoutes = router;
