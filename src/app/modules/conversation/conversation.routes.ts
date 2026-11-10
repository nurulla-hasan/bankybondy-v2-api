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
// Chats THIS user hid — the counterpart of `/hide`, so they can be unhidden.
router.get(
    '/get-hidden-chats',
    auth(USER_ROLE.user),
    ConversationController.getHiddenChatList
);
router.get(
    '/get-media-files/:id',
    auth(USER_ROLE.user),
    ConversationController.getConversationMediaFiles
);
// Hide/unhide a conversation for this user only.
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
