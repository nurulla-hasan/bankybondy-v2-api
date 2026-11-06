import express from 'express';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';
import messageController from './message.controller';

const router = express.Router();

router.get(
    '/get-messages',
    auth(USER_ROLE.user),
    messageController.getMessages
);

router.get(
    '/unread-count',
    auth(USER_ROLE.user),
    messageController.getUnreadCount
);

// Marcar como leída una conversación por HTTP (gemelo del `seen` del socket).
router.post(
    '/mark-seen',
    auth(USER_ROLE.user),
    messageController.markSeenMessages
);

// Enviar un mensaje 1-a-1 por HTTP (gemelo de la rama `receiver` del socket).
router.post('/send', auth(USER_ROLE.user), messageController.sendMessage);

router.delete(
    '/delete-message/:id',
    auth(USER_ROLE.user),
    messageController.deleteMessage
);

export const messageRoutes = router;
