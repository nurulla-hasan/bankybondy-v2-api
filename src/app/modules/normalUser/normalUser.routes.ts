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

// Precios de los planes. SIN auth a propósito: son información pública y la
// página de suscripciones tiene que poder mostrarlos aunque nadie haya iniciado
// sesión. No expone nada más que los precios y los límites.
router.get(
    '/subscription-prices',
    // Público + efecto saliente (puede terminar en un axios a dolarapi con
    // timeout de 5 s si la caché de la cotización está vencida). Misma
    // convención que `contactLimiter`, que está puesto por exactamente eso.
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

// PALANCA MANUAL DEL PLAN (contracargos y reparaciones). Es la ÚNICA vía por la
// que un plan puede BAJAR, así que va con el permiso más alto: `superAdmin`.
// Se eligió a conciencia sobre incluir `admin`: otorgar Premium es regalar plata
// y revocarlo es sacársela a alguien que pagó. Si hace falta que un admin común
// lo haga, es una decisión de producto que se toma aparte, no un default.
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
