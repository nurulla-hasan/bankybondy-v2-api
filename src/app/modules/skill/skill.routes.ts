import express from 'express';

import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';
import SkillController from './skill.controller';
import validateRequest from '../../middlewares/validateRequest';
import SkillValidations from './skill.validation';

const router = express.Router();

router.post(
    '/create-skill',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    validateRequest(SkillValidations.createSkillValidationSchema),
    SkillController.createSkill
);

router.get(
    '/all-skills',
    // auth(USER_ROLE.superAdmin, USER_ROLE.admin, USER_ROLE.user),
    SkillController.getAllSkills
);

router.get(
    '/single-skill/:skillId',
    // auth(USER_ROLE.superAdmin, USER_ROLE.admin, USER_ROLE.user),
    SkillController.getSkillById
);

router.patch(
    '/update-skill/:skillId',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    validateRequest(SkillValidations.updateSkillValidationSchema),
    SkillController.updateSkill
);

router.delete(
    '/delete-skill/:skillId',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    SkillController.deleteSkill
);

export const skillRoutes = router;
