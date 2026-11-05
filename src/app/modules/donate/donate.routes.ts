import express from 'express';
import { createDonate, getAllDonates } from './donate.controller';
import validateRequest from '../../middlewares/validateRequest';
import { DonateValidations } from './donate.validation';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';
import { checkoutCreateLimiter } from '../../middlewares/rateLimiter';

const router = express.Router();

router.post(
    '/donate',
    auth(USER_ROLE.user),
    checkoutCreateLimiter,
    validateRequest(DonateValidations.createDonateSchema),
    createDonate
);
router.get(
    '/get-all-donner',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    getAllDonates
);

export const DonateRoutes = router;
