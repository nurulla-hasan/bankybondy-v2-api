import express from 'express';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';
import SearchController from './search.controller';

const router = express.Router();

// Busqueda global ligera (personas, bonos y audios) para el usuario autenticado.
router.get('/global', auth(USER_ROLE.user), SearchController.globalSearch);

export const searchRoutes = router;
