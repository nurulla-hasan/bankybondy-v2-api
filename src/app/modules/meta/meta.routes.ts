import express from 'express';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';
import MetaController from './meta.controller';

const router = express.Router();

router.get(
    '/get-meta-data',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    MetaController.getDashboardMetaData
);

router.get(
    '/user-chart-data',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    MetaController.getUserChartData
);
router.get(
    '/donor-chart-data',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    MetaController.donorGrowthChartData
);
// PARKED (instituciones apagadas: inaccesibles para TODOS, incluido admin). La
// métrica de instituciones se desmonta mientras el módulo esté apagado. El
// controller/servicio quedan intactos; reactivar = descomentar ("solo cablear").
// router.get(
//     '/institution-chart-data',
//     auth(USER_ROLE.superAdmin, USER_ROLE.admin),
//     MetaController.getInstitutionChartData
// );
router.get(
    '/audio-pie-chart',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    MetaController.getAudioPieChartData
);
router.get(
    '/bond-chart-data',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    MetaController.bondChartData
);
router.get(
    '/earning-chart-data',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    MetaController.getEarningChartData
);

// Income: ingresos por categoría (donación / standard / premium) en el tiempo.
router.get(
    '/income-chart-data',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    MetaController.getIncomeChartData
);

// C.1 (Tanda 2): donantes distintos + monto total donado.
router.get(
    '/donation-stats',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    MetaController.getDonationStats
);

// C.2 (Tanda 2): conteo de usuarios por tipo de suscripcion.
router.get(
    '/subscription-stats',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    MetaController.getSubscriptionStats
);

// C.4 (Tanda 2): agregacion de usuarios por ciudad/coordenada (mapa de calor).
router.get(
    '/user-geo-aggregation',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    MetaController.getUserGeoAggregation
);

export const metaRoutes = router;
