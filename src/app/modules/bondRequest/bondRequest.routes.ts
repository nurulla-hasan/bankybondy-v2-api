import express from 'express';
import auth from '../../middlewares/auth';
import { bondCreateLimiter } from '../../middlewares/rateLimiter';
import validateRequest from '../../middlewares/validateRequest';
import { USER_ROLE } from '../user/user.constant';
import bondRequestController from './bondRequest.controller';
import bondRequestValidation from './bondRequest.validation';

const router = express.Router();

router.post(
    '/create',
    // `auth` primero para poblar req.user; el limiter se keyea por usuario.
    auth(USER_ROLE.user),
    bondCreateLimiter,
    validateRequest(bondRequestValidation.createBondRequestValidationSchema),
    bondRequestController.createBondRequest
);

router.get(
    '/all-bond-requests',
    // Admin-only: el front no lo usa; para un usuario común era un dump del dataset
    // (todos los bonos, incluidos pausados/linkeados/ajenos). Los propios van por
    // /my-bond-requests.
    auth(USER_ROLE.admin, USER_ROLE.superAdmin),
    bondRequestController.getAllBondRequests
);
router.get(
    '/my-bond-requests',
    auth(USER_ROLE.user),
    bondRequestController.getMyBondRequests
);
router.get(
    '/get-single-bond-request/:id',
    auth(USER_ROLE.user),
    bondRequestController.getSingleBondRequest
);
router.get(
    '/get-last-bond',
    auth(USER_ROLE.user),
    bondRequestController.getLastBond
);

// Editar el CONTENIDO de un vínculo está prohibido, pero PAUSAR no: pausado es
// uno de los tres estados válidos de un vínculo (activo / pausado / eliminado) y
// es el único interruptor que lo saca del pool de matcheo.
//
// Esta ruta llegó a estar cortada con un 403 plano, y eso rompió el botón de
// pausa del front, que pega justo acá con `{isPause}`. El bloqueo ahora es por
// CAMPO, dentro del service: sólo pasa `isPause`; cualquier otro campo (offer,
// want, description, location, radius, modality) se rechaza con 403.
router.patch(
    '/update/:id',
    auth(USER_ROLE.user),
    validateRequest(bondRequestValidation.updateBondRequestValidationSchema),
    bondRequestController.updateBondRequest
);

router.delete(
    '/delete/:id',
    auth(USER_ROLE.user),
    bondRequestController.deleteBondRequest
);
router.get(
    '/matching-bond',
    auth(USER_ROLE.user),
    bondRequestController.getMatchingBondRequest
);
router.get(
    '/by-user/:userId',
    auth(USER_ROLE.user),
    bondRequestController.getBondRequestsByUser
);

export const bondRequestRoutes = router;
