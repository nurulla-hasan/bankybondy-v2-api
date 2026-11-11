import { Router } from 'express';
import auth from '../../middlewares/auth';
import validateRequest from '../../middlewares/validateRequest';
import { USER_ROLE } from '../user/user.constant';
import { matchingSettingsController } from './matchingSettings.controller';
import { matchingSettingsValidation } from './matchingSettings.validation';

const router = Router();

router.get('/matching', auth(USER_ROLE.admin, USER_ROLE.superAdmin), matchingSettingsController.getMatching);
router.patch(
    '/matching',
    auth(USER_ROLE.superAdmin),
    validateRequest(matchingSettingsValidation.update),
    matchingSettingsController.updateMatching
);

export const settingsRoutes = router;
