import express from 'express';
import auth from '../../middlewares/auth';
import parseMultipartData from '../../middlewares/parseMultipartData';
import { USER_ROLE } from '../user/user.constant';
import validateRequest from '../../middlewares/validateRequest';
import categoryValidation from './category.validation';
import categoryController from './category.controller';
import { uploadFile } from '../../helper/mutler-s3-uploader';

const router = express.Router();

router.post(
    '/create-category',
    auth(USER_ROLE.superAdmin),
    uploadFile(),
    parseMultipartData,
    validateRequest(categoryValidation.createCategoryValidationSchema),
    categoryController.createCategory
);
router.patch(
    '/update-category/:id',
    auth(USER_ROLE.superAdmin),
    uploadFile(),
    parseMultipartData,
    validateRequest(categoryValidation.updateCategoryValidationSchema),
    categoryController.updateCategory
);

router.get('/all-categories', categoryController.getAllCategories);
router.get('/get-single-category/:id', categoryController.getSingleCategory);
router.delete(
    '/delete-category/:id',
    auth(USER_ROLE.superAdmin),
    categoryController.deleteCategory
);

export const categoryRoutes = router;
