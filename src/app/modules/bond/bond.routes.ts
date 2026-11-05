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
    // Antes SIN auth → IDOR público: con un id se leía el bond + el perfil del
    // dueño (populate('user')). Se exige sesión (consistente con el resto de
    // /bond) y el service ya recorta el populate a name/profile_image.
    auth(USER_ROLE.user),
    bondController.getSingleBond
);
router.get(
    '/get-filter-items',
    auth(USER_ROLE.user),
    bondController.getFilterItemsForMatchingBond
);

// PARKEADO: editar un vínculo está PROHIBIDO (crashea, y el producto lo
// descartó). Se corta el acceso HTTP y nada más: el controller, el service y la
// validación quedan INTACTOS. Reactivar = borrar este handler y descomentar el
// bloque de abajo ("solo cablear"), igual que los módulos parkeados del router.
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
