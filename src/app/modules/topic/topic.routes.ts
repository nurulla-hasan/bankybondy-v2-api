import express from 'express';

import auth from '../../middlewares/auth';
import parseMultipartData from '../../middlewares/parseMultipartData';
import validateRequest from '../../middlewares/validateRequest';
import { USER_ROLE } from '../user/user.constant';
import TopicController from './topic.controller';
import TopicValidations from './topic.validation';
import { uploadFile } from '../../helper/mutler-s3-uploader';

const router = express.Router();

router.post(
    '/create-topic',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    uploadFile(),
    parseMultipartData,
    // validateRequest goes AFTER `data` parsing (the real `name` lives there).
    validateRequest(TopicValidations.createTopicValidationSchema),
    TopicController.createTopic
);

router.get(
    '/all-topics',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin, USER_ROLE.user),
    TopicController.getAllTopics
);

router.get(
    '/single-topic/:topicId',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin, USER_ROLE.user),
    TopicController.getTopicById
);

router.patch(
    '/update-topic/:topicId',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    uploadFile(),
    parseMultipartData,
    validateRequest(TopicValidations.updateTopicValidationSchema),
    TopicController.updateTopic
);

router.delete(
    '/delete-topic/:topicId',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    TopicController.deleteTopic
);

export const topicRoutes = router;
