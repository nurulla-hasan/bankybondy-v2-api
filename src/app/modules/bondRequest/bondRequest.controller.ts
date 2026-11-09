import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import originalSendResponse from '../../utilities/sendResponse';
import bondRequestService from './bondRequest.service';
import { publicBondData } from './bondIdentity';

const sendResponse: typeof originalSendResponse = (res, payload) =>
    originalSendResponse(res, { ...payload, data: publicBondData(payload.data) });

const createBondRequest = catchAsync(async (req, res) => {
    const result = await bondRequestService.createBondRequestIntoDB(
        req.user.profileId,
        req.body
    );
    sendResponse(res, {
        statusCode: httpStatus.CREATED,
        success: true,
        message: 'BondRequest created successfully',
        data: result,
    });
});

const getAllBondRequests = catchAsync(async (req, res) => {
    const result = await bondRequestService.getAllBondRequests(req.query);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'BondRequests retrieved successfully',
        data: result,
    });
});
const getLastBond = catchAsync(async (req, res) => {
    const result = await bondRequestService.getLastBond(req.user.profileId);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Last bond retrieved successfully',
        data: result,
    });
});

const getMyBondRequests = catchAsync(async (req, res) => {
    const result = await bondRequestService.myBondRequests(
        req.user.profileId,
        req.query
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'BondRequests retrieved successfully',
        data: result,
    });
});

const getSingleBondRequest = catchAsync(async (req, res) => {
    const result = await bondRequestService.getSingleBondRequest(
        req.params.id,
        (req.user as { profileId?: string })?.profileId
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'BondRequest retrieved successfully',
        data: result,
    });
});

const updateBondRequest = catchAsync(async (req, res) => {
    const result = await bondRequestService.updateBondRequestIntoDB(
        req.user.profileId,
        req.params.id,
        req.body
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'BondRequest updated successfully',
        data: result,
    });
});

const deleteBondRequest = catchAsync(async (req, res) => {
    const result = await bondRequestService.deleteBondRequestFromDB(
        req.user.profileId,
        req.params.id
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'BondRequest deleted successfully',
        data: result,
    });
});

const getBondRequestsByUser = catchAsync(async (req, res) => {
    const result = await bondRequestService.getBondRequestsByUser(
        req.params.userId,
        req.user.profileId,
        // Buscador de vínculos dentro del perfil (opcional).
        typeof req.query.searchTerm === 'string'
            ? req.query.searchTerm
            : undefined,
        req.query.page,
        req.query.limit
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'User bond requests retrieved successfully',
        data: result,
    });
});

const getMatchingBondRequest = catchAsync(async (req, res) => {
    const result = await bondRequestService.getMatchingBondRequest(
        req.user.profileId,
        req.query.bondRequest as string,
        req.query
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'BondRequest matching successfully',
        data: result,
    });
});

const getBondQuota = catchAsync(async (req, res) => {
    const result = await bondRequestService.getBondQuota(req.user.profileId);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Bond quota retrieved successfully',
        data: result,
    });
});

const bondRequestController = {
    createBondRequest,
    getAllBondRequests,
    getSingleBondRequest,
    updateBondRequest,
    deleteBondRequest,
    getMyBondRequests,
    getBondQuota,
    getMatchingBondRequest,
    getBondRequestsByUser,
    getLastBond,
};

export default bondRequestController;
