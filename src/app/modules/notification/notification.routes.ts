import { USER_ROLE } from '../user/user.constant';
import express from 'express';
import auth from '../../middlewares/auth';
import notificationController from './notification.controller';
const router = express.Router();

router.get(
    '/get-notifications',
    auth(USER_ROLE.superAdmin, USER_ROLE.user),
    notificationController.getAllNotification
);
// Conteo de no vistas (+ última notificación) para sembrar el badge en la carga
// inicial. La vista en vivo se mantiene por el evento socket 'notification', que
// ya emite exactamente esta misma forma. Aditivo: no toca los otros endpoints.
router.get(
    '/unseen-count',
    auth(USER_ROLE.superAdmin, USER_ROLE.user),
    notificationController.getUnseenCount
);
router.patch(
    '/see-notifications',
    auth(USER_ROLE.superAdmin, USER_ROLE.user),
    notificationController.seeNotification
);
// Marca UNA notificación como vista (al abrir esa notificación puntual). El badge
// baja de a una, no al abrir la campana.
router.patch(
    '/see-notification/:id',
    auth(USER_ROLE.superAdmin, USER_ROLE.user),
    notificationController.seeOneNotification
);
router.delete(
    '/delete-notification/:id',
    auth(USER_ROLE.superAdmin, USER_ROLE.user),
    notificationController.deleteNoficiation
);

// Preferencias de silenciado por categoría (Tanda C): traer y guardar qué
// categorías silenció el usuario. Sólo usuarios normales (el admin no silencia).
router.get(
    '/preferences',
    auth(USER_ROLE.user),
    notificationController.getPreferences
);
router.patch(
    '/preferences',
    auth(USER_ROLE.user),
    notificationController.updatePreferences
);

// Preview del digest semanal a la propia casilla (Fase 4). POST sin body.
router.post(
    '/digest-preview',
    auth(USER_ROLE.user),
    notificationController.digestPreview
);

// Baja del resumen/digest (List-Unsubscribe). PÚBLICO: la autorización es el token
// firmado que viaja en el link del correo (no hay login). POST = one-click de Gmail;
// GET = clic manual → página de confirmación.
router.post(
    '/digest-unsubscribe/:token',
    notificationController.digestUnsubscribe
);
router.get(
    '/digest-unsubscribe/:token',
    notificationController.digestUnsubscribe
);

export const notificationRoutes = router;
