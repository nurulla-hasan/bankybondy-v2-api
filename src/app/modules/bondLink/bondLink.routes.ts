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

// Reject a trade: marks it NOT COMPLETED for everyone, the rejecter leaves the
// chat, plus optional role-relative block (nobody blocks themselves).
router.post(
    '/reject/:id',
    auth(USER_ROLE.user),
    validateRequest(BondLinkValidations.rejectBondLinkSchema),
    bondLinkController.rejectBondLink
);

export const bondLinkRoutes = router;
