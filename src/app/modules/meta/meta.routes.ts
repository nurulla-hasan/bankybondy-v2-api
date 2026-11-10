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

// Income: revenue by category (donation / standard / premium) over time.
router.get(
    '/income-chart-data',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    MetaController.getIncomeChartData
);

// Distinct donors + total donated amount.
router.get(
    '/donation-stats',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    MetaController.getDonationStats
);

// User count by subscription type.
router.get(
    '/subscription-stats',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    MetaController.getSubscriptionStats
);

// Users aggregated by city/coordinate (heat map).
router.get(
    '/user-geo-aggregation',
    auth(USER_ROLE.superAdmin, USER_ROLE.admin),
    MetaController.getUserGeoAggregation
);

export const metaRoutes = router;
