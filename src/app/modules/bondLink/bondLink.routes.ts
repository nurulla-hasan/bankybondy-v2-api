import express from 'express';
import auth from '../../middlewares/auth';
import validateRequest from '../../middlewares/validateRequest';
import { USER_ROLE } from '../user/user.constant';
import bondLinkController from './bondLink.controller';
import BondLinkValidations from './bondLink.validation';

const router = express.Router();

router.post(
    '/create',
    auth(USER_ROLE.user),
    validateRequest(BondLinkValidations.createBondLinkSchema),

    bondLinkController.createBondLink
);
router.get(
    '/my-bond-links',
    auth(USER_ROLE.user),
    bondLinkController.getMyBondLinks
);
router.get(
    '/get-single-bond-link/:id',
    auth(USER_ROLE.user),
    bondLinkController.getSingleBondLink
);

router.post(
    '/mark-as-complete/:id',
    auth(USER_ROLE.user),
    bondLinkController.markAsCompleteBond
);

// Rechazar un trueque: lo da por NO CONCRETADO para todos + el que rechaza sale
// del chat + bloqueo opcional (relativo al rol, nadie se bloquea a sí mismo).
router.post(
    '/reject/:id',
    auth(USER_ROLE.user),
    validateRequest(BondLinkValidations.rejectBondLinkSchema),
    bondLinkController.rejectBondLink
);

export const bondLinkRoutes = router;
