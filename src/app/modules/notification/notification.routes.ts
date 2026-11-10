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
// Unseen count (+ latest notification) to seed the badge on initial load; the
// socket 'notification' event keeps it live with the same shape.
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
// Mark ONE notification as seen (on opening it); the badge drops one at a time.
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

// Per-category mute preferences: read and save which categories the user muted.
// Normal users only (admins do not mute).
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

// Preview of the weekly digest sent to the caller's own inbox. POST without body.
router.post(
    '/digest-preview',
    auth(USER_ROLE.user),
    notificationController.digestPreview
);

// Digest unsubscribe (List-Unsubscribe). PUBLIC: the signed token in the email
// link is the authorization. POST = Gmail one-click; GET = manual click.
router.post(
    '/digest-unsubscribe/:token',
    notificationController.digestUnsubscribe
);
router.get(
    '/digest-unsubscribe/:token',
    notificationController.digestUnsubscribe
);

export const notificationRoutes = router;
