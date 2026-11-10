import express from 'express';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';
import SearchController from './search.controller';

const router = express.Router();

// Lightweight global search (people, bonds and audios) for the authenticated user.
router.get('/global', auth(USER_ROLE.user), SearchController.globalSearch);

export const searchRoutes = router;
