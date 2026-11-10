import express from 'express';
import { uploadFile } from '../../helper/mutler-s3-uploader';
import auth from '../../middlewares/auth';
import parseMultipartData from '../../middlewares/parseMultipartData';
import {
    checkoutCreateLimiter,
    pricesLimiter,
} from '../../middlewares/rateLimiter';
import validateRequest from '../../middlewares/validateRequest';
import { USER_ROLE } from '../user/user.constant';
import NormalUserController from './normalUser.controller';
import normalUserValidations from './normalUser.validation';

const router = express.Router();

router.patch(
    '/update-profile',
    auth(USER_ROLE.user),
    uploadFile(),
    parseMultipartData,
    validateRequest(normalUserValidations.updateNormalUserData),
    NormalUserController.updateUserProfile
);

router.patch(
    '/update-location',
    auth(USER_ROLE.user),
    validateRequest(normalUserValidations.updateLocationSchema),
    NormalUserController.updateLocation
);

router.get(
    '/get-all-user',
    auth(USER_ROLE.superAdmin, USER_ROLE.user),
    NormalUserController.getAllUser
);

router.get(
    '/single-user/:id',
    auth(USER_ROLE.superAdmin, USER_ROLE.user),
    NormalUserController.getSingleUser
);

// Plan prices. No auth on purpose: public info for the subscriptions page.
router.get(
    '/subscription-prices',
    // Public but has an outbound effect (dolarapi via axios, 5 s timeout) → rate
    // limited, same convention as contactLimiter.
    pricesLimiter,
    NormalUserController.getSubscriptionPrices
);

router.post(
    '/subscribe',
    auth(USER_ROLE.user),
    checkoutCreateLimiter,
    validateRequest(normalUserValidations.subscriptionValidationSchema),
    NormalUserController.purchaseSubscription
);

// Manual plan override (chargebacks, repairs), the only path that can downgrade,
// so it requires the highest role: superAdmin.
router.patch(
    '/admin/subscription/:id',
    auth(USER_ROLE.superAdmin),
    validateRequest(normalUserValidations.adminSetSubscriptionSchema),
    NormalUserController.setSubscriptionByAdmin
);

router.patch(
    '/bonds-visibility',
    auth(USER_ROLE.user),
    NormalUserController.updateBondsVisibility
);

router.patch(
    '/people-visibility',
    auth(USER_ROLE.user),
    NormalUserController.updatePeopleVisibility
);

export const normalUserRoutes = router;
