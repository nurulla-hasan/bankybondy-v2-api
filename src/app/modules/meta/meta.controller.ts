import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import MetaService from './meta.service';

const getDashboardMetaData = catchAsync(async (req, res) => {
    const result = await MetaService.getDashboardMetaData();
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Dashboard meta data retrieved successfully',
        data: result,
    });
});

const getUserChartData = catchAsync(async (req, res) => {
    const result = await MetaService.getUserChartData(Number(req?.query.year));
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'User chart data retrieved successfully',
        data: result,
    });
});
const donorGrowthChartData = catchAsync(async (req, res) => {
    const result = await MetaService.donorGrowthChartData(
        Number(req?.query.year)
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Donor growth chart data retrieved successfully',
        data: result,
    });
});
const bondChartData = catchAsync(async (req, res) => {
    const result = await MetaService.bondChartData(Number(req?.query.year));
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Bond chart data retrieved successfully',
        data: result,
    });
});
const getAudioPieChartData = catchAsync(async (req, res) => {
    const result = await MetaService.getAudioPieChartData();
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Audio chart data retrieved successfully',
        data: result,
    });
});
const getEarningChartData = catchAsync(async (req, res) => {
    const result = await MetaService.getEarningChartData(
        Number(req.query.year)
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Earning chart data retrieved successfully',
        data: result,
    });
});

// Income: ingresos por categoría (donación / standard / premium) en el tiempo.
// Query: year, currency ('USD'|'ARS'), granularity ('month'|'year').
const getIncomeChartData = catchAsync(async (req, res) => {
    const result = await MetaService.getIncomeChartData(
        Number(req.query.year),
        req.query.currency as string,
        req.query.granularity as string
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Income chart data retrieved successfully',
        data: result,
    });
});

// C.1 (Tanda 2): donantes distintos + monto total donado.
const getDonationStats = catchAsync(async (req, res) => {
    const result = await MetaService.getDonationStats();
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Donation stats retrieved successfully',
        data: result,
    });
});

// C.2 (Tanda 2): conteo de usuarios por tipo de suscripcion.
const getSubscriptionStats = catchAsync(async (req, res) => {
    const result = await MetaService.getSubscriptionStats();
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Subscription stats retrieved successfully',
        data: result,
    });
});

// C.4 (Tanda 2): agregacion de usuarios por ciudad/coordenada (mapa de calor).
const getUserGeoAggregation = catchAsync(async (req, res) => {
    const result = await MetaService.getUserGeoAggregation();
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'User geo aggregation retrieved successfully',
        data: result,
    });
});

const MetaController = {
    getDashboardMetaData,
    getUserChartData,
    getAudioPieChartData,
    donorGrowthChartData,
    bondChartData,
    getEarningChartData,
    getIncomeChartData,
    getDonationStats,
    getSubscriptionStats,
    getUserGeoAggregation,
};

export default MetaController;
