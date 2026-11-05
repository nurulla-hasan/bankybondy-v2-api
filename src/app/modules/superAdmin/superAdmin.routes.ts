import express from 'express';
import auth from '../../middlewares/auth';
import parseMultipartData from '../../middlewares/parseMultipartData';
import { USER_ROLE } from '../user/user.constant';
import validateRequest from '../../middlewares/validateRequest';
import superAdminValidations from './superAdmin.validation';
import SuperAdminController from './superAdmin.controller';
import { uploadFile } from '../../helper/mutler-s3-uploader';

const router = express.Router();

router.patch(
    '/update-profile',
    auth(USER_ROLE.superAdmin),
    uploadFile(),
    parseMultipartData,
    validateRequest(superAdminValidations.updateSuperAdminSchema),
    SuperAdminController.updateUserProfile
);

export const superAdminRoutes = router;
