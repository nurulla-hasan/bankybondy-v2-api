import express from 'express';
import auth from '../../middlewares/auth';
import parseMultipartData from '../../middlewares/parseMultipartData';
import { USER_ROLE } from '../user/user.constant';
import validateRequest from '../../middlewares/validateRequest';
import commentValidations from './comment.validation';
import commentController from './comment.controller';
import { uploadFile } from '../../helper/mutler-s3-uploader';

const router = express.Router();

router.post(
    '/create',
    auth(USER_ROLE.user),
    uploadFile(),
    parseMultipartData,
    validateRequest(commentValidations.createCommentSchema),
    commentController.createComment
);
router.post(
    '/create-reply',
    auth(USER_ROLE.user),
    uploadFile(),
    parseMultipartData,
    validateRequest(commentValidations.createReplySchema),
    commentController.createReply
);
router.patch(
    '/update-comment/:id',
    auth(USER_ROLE.user),
    uploadFile(),
    parseMultipartData,
    validateRequest(commentValidations.updateCommentValidationSchema),
    commentController.updateComment
);
router.delete(
    '/delete-comment/:id',
    auth(USER_ROLE.user),

    commentController.deleteComment
);

router.post(
    '/like-unlike/:id',
    auth(USER_ROLE.user),
    commentController.likeUnlikeComment
);

router.get(
    '/get-conversation-comments/:id',
    auth(USER_ROLE.user),
    commentController.getPodcastComments
);

router.get(
    '/get-replies/:id',
    auth(USER_ROLE.user),
    commentController.getReplies
);
router.get(
    '/get-likers/:id',
    auth(USER_ROLE.user),
    commentController.getAllLikersForComment
);

export const commentRoutes = router;
