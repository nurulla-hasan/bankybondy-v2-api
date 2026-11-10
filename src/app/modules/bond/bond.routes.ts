import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import bondValidation from './bond.validation';
import bondController from './bond.controller';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';

const router = express.Router();

router.post(
    '/create',
    auth(USER_ROLE.user),
    validateRequest(bondValidation.createBondValidationSchema),
    bondController.createBond
);

router.get('/my-bonds', auth(USER_ROLE.user), bondController.getAllBonds);
router.get(
    '/get-single-bond/:id',
    // Session required: this was public, so any id leaked the bond plus the owner
    // profile (populate 'user'). The service narrows that populate.
    auth(USER_ROLE.user),
    bondController.getSingleBond
);
router.get(
    '/get-filter-items',
    auth(USER_ROLE.user),
    bondController.getFilterItemsForMatchingBond
);

// PARKED: editing a bond link is forbidden (it crashes; product dropped it). Only HTTP
// access is cut — controller, service and validation stay intact. Re-enable by
// deleting this handler and uncommenting the block below ("wire only").
router.patch('/update/:id', (_req, res) => {
    res.status(403).json({
        success: false,
        message: 'La edición de vínculos está deshabilitada.',
    });
});
// router.patch(
//     '/update/:id',
//     auth(USER_ROLE.user),
//     validateRequest(bondValidation.updateBondValidationSchema),
//     bondController.updateBond
// );

router.delete('/delete/:id', auth(USER_ROLE.user), bondController.deleteBond);

export const bondRoutes = router;
