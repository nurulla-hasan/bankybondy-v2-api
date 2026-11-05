import express from 'express';
import auth from '../../middlewares/auth';
import parseMultipartData from '../../middlewares/parseMultipartData';
import { USER_ROLE } from '../user/user.constant';
import validateRequest from '../../middlewares/validateRequest';
import bannerValidations from './banner.validation';
import bannerController from './banner.controller';
import { uploadFile } from '../../helper/mutler-s3-uploader';

const router = express.Router();

router.post(
    '/create-banner',
    auth(USER_ROLE.superAdmin),
    uploadFile(),
    parseMultipartData,
    validateRequest(bannerValidations.createBannerValidationSchema),
    bannerController.createBanner
);

router.get('/get-all-banner', bannerController.getAllBanners);

router.patch(
    '/update-banner/:id',
    auth(USER_ROLE.superAdmin),
    uploadFile(),
    parseMultipartData,
    validateRequest(bannerValidations.createBannerValidationSchema),
    bannerController.updateBanner
);

router.delete(
    '/delete-banner/:id',
    auth(USER_ROLE.superAdmin),
    bannerController.deleteBanner
);

export const bannerRoutes = router;
