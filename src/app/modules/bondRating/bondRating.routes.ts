import express from 'express';
import auth from '../../middlewares/auth';
import validateRequest from '../../middlewares/validateRequest';
import { USER_ROLE } from '../user/user.constant';
import bondRatingController from './bondRating.controller';
import bondRatingValidations from './bondRating.validation';

const router = express.Router();

router.post(
    '/add-rating',
    auth(USER_ROLE.user),
    validateRequest(bondRatingValidations.addRatingValidation),
    bondRatingController.addRating
);

// Public view of the ratings/comments a user received. Any authenticated user.
router.get(
    '/public/:userId',
    auth(USER_ROLE.user, USER_ROLE.admin, USER_ROLE.superAdmin),
    bondRatingController.getPublicRatings
);

export const bondRatingRoutes = router;
