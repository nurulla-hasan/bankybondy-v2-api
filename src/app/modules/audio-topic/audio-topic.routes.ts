import express from 'express';
import auth from '../../middlewares/auth';
import parseMultipartData from '../../middlewares/parseMultipartData';
import { USER_ROLE } from '../user/user.constant';
import validateRequest from '../../middlewares/validateRequest';
import audioTopicController from './audio-topic.controller';
import { uploadFile } from '../../helper/fileUploader';
import audioTopicValidations from './audio-topic.validation';

const router = express.Router();

router.post(
    '/create',
    // Catálogo GLOBAL compartido (sin dueño): solo staff puede mutarlo. Antes
    // estaba en USER_ROLE.user, así que cualquier usuario podía crear/editar/borrar
    // temas de todos (y el delete borra la imagen de S3). -> admin/superAdmin.
    auth(USER_ROLE.admin, USER_ROLE.superAdmin),
    uploadFile(),
    parseMultipartData,
    validateRequest(audioTopicValidations.createAudioTopicSchema),
    audioTopicController.createAudioTopic
);

router.patch(
    '/update/:id',
    auth(USER_ROLE.admin, USER_ROLE.superAdmin),
    uploadFile(),
    parseMultipartData,
    validateRequest(audioTopicValidations.updateAudioTopicSchema),
    audioTopicController.updateAudioTopic
);

router.delete(
    '/delete/:id',
    auth(USER_ROLE.admin, USER_ROLE.superAdmin),
    audioTopicController.deleteAudioTopic
);

router.get(
    '/get-all',
    auth(USER_ROLE.user),
    audioTopicController.getAllAudioTopics
);

router.get(
    '/get-single/:id',
    auth(USER_ROLE.user),
    audioTopicController.getSingleAudioTopic
);

export const audioTopicRoutes = router;
