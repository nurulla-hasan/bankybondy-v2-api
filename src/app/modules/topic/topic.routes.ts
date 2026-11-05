import express from 'express';

import auth from '../../middlewares/auth';
import parseMultipartData from '../../middlewares/parseMultipartData';
import validateRequest from '../../middlewares/validateRequest';
import { USER_ROLE } from '../user/user.constant';
import TopicController from './topic.controller';
import TopicValidations from './topic.validation';
import { uploadFile } from '../../helper/mutler-s3-uploader';

const router = express.Router();

// Route to create a new topic
router.post(
    '/create-topic',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    uploadFile(),
    parseMultipartData,
    // validateRequest DESPUES del parseo de `data` (ahi vive el `name` real).
    validateRequest(TopicValidations.createTopicValidationSchema),
    TopicController.createTopic
);

// Route to get all topics
router.get(
    '/all-topics',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin, USER_ROLE.user),
    TopicController.getAllTopics
);

// Route to get a topic by ID
router.get(
    '/single-topic/:topicId',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin, USER_ROLE.user),
    TopicController.getTopicById
);

// Route to update a topic by ID
router.patch(
    '/update-topic/:topicId',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    uploadFile(),
    parseMultipartData,
    validateRequest(TopicValidations.updateTopicValidationSchema),
    TopicController.updateTopic
);

// Route to delete a topic by ID
router.delete(
    '/delete-topic/:topicId',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    TopicController.deleteTopic
);

export const topicRoutes = router;
