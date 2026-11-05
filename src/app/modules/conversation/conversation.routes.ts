import express from 'express';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';
import ConversationController from './conversation.controller';

const router = express.Router();

router.get(
    '/get-chat-list',
    auth(USER_ROLE.user),
    ConversationController.getChatList
);
router.get(
    '/get-media-files/:id',
    auth(USER_ROLE.user),
    ConversationController.getConversationMediaFiles
);
// B.7 (Tanda 2): ocultar/des-ocultar una conversacion solo para el usuario.
router.patch(
    '/hide/:id',
    auth(USER_ROLE.user),
    ConversationController.hideConversation
);
router.patch(
    '/unhide/:id',
    auth(USER_ROLE.user),
    ConversationController.unhideConversation
);
export const conversationRoutes = router;
