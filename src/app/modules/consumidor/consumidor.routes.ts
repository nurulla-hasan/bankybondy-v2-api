import express from 'express';
import validateRequest from '../../middlewares/validateRequest';
import { consumidorLimiter } from '../../middlewares/rateLimiter';
import { crearSolicitud } from './consumidor.controller';
import { ConsumidorValidations } from './consumidor.validation';

const router = express.Router();

// PÚBLICO y sin `auth`, a propósito: la Disp. 954/2025 prohíbe exigir
// registración previa para el botón de arrepentimiento y el de baja.
router.post(
    '/solicitud',
    consumidorLimiter,
    validateRequest(ConsumidorValidations.crearSolicitudSchema),
    crearSolicitud
);

export const consumidorRoutes = router;
