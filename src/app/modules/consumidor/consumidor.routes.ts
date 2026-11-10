import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { consumidorLimiter } from '../../middlewares/rateLimiter';
import { crearSolicitud } from './consumidor.controller';
import { ConsumidorValidations } from './consumidor.validation';

const router = express.Router();

// Public and deliberately unauthenticated: Disp. 954/2025 forbids requiring
// prior signup for the "arrepentimiento" and cancellation buttons.
router.post(
    '/solicitud',
    consumidorLimiter,
    validateRequest(ConsumidorValidations.crearSolicitudSchema),
    crearSolicitud
);

export const consumidorRoutes = router;
