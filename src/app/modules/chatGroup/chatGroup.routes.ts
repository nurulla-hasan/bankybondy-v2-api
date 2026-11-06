import express from 'express';
import auth from '../../middlewares/auth';
import parseMultipartData from '../../middlewares/parseMultipartData';
import { USER_ROLE } from '../user/user.constant';
import validateRequest from '../../middlewares/validateRequest';
import chatGroupValidations from './chatGroup.validation';
import chatGroupController from './chatGroup.controller';
import { uploadFile } from '../../helper/mutler-s3-uploader';

const router = express.Router();

router.post(
    '/create',
    auth(USER_ROLE.user),
    uploadFile(),
    parseMultipartData,
    validateRequest(chatGroupValidations.createChatGroupData),
    chatGroupController.createGroupChat
);
router.patch(
    '/update/:id',
    auth(USER_ROLE.user),
    uploadFile(),
    parseMultipartData,
    validateRequest(chatGroupValidations.updateChatGroupData),
    chatGroupController.updateGroupData
);
router.get(
    '/get/:id',
    auth(USER_ROLE.user),
    chatGroupController.getGroupMembers
);
router.post(
    '/add-member/:id',
    auth(USER_ROLE.user),

    validateRequest(chatGroupValidations.addMemberValidationSchema),
    chatGroupController.addMember
);
router.post(
    '/remove-member/:id',
    auth(USER_ROLE.user),

    validateRequest(chatGroupValidations.addMemberValidationSchema),
    chatGroupController.removeMember
);

export const chatGroupRoutes = router;
