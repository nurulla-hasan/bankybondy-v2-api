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

// Mark a conversation as read over HTTP (twin of the socket `seen` event).
router.post(
    '/mark-seen',
    auth(USER_ROLE.user),
    messageController.markSeenMessages
);

// Send a 1-to-1 message over HTTP (twin of the socket `receiver` branch).
router.post('/send', auth(USER_ROLE.user), messageController.sendMessage);

router.delete(
    '/delete-message/:id',
    auth(USER_ROLE.user),
    messageController.deleteMessage
);

export const messageRoutes = router;
