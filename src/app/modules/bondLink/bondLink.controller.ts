import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import originalSendResponse from '../../utilities/sendResponse';
import bondLinkServices from './bondLink.service';
import { publicBondData } from '../bondRequest/bondIdentity';

const sendResponse: typeof originalSendResponse = (res, payload) =>
    originalSendResponse(res, { ...payload, data: publicBondData(payload.data) });

const createBondLink = catchAsync(async (req, res) => {
    // Anti-IDOR: the service checks the caller (req.user.profileId) is a
    // participant; the body is not trusted to say who creates.
    const result = await bondLinkServices.createBondLink(
        req.body,
        req.user.profileId
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Bond links created successfully',
        data: result,
    });
});
const getMyBondLinks = catchAsync(async (req, res) => {
    const result = await bondLinkServices.getMyBondLinks(
        req.user.profileId,
        req.query
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Bond links retrieved successfully',
        data: result,
    });
});
const getSingleBondLink = catchAsync(async (req, res) => {
    const result = await bondLinkServices.getSingleBondLink(
        req.user.profileId,
        req.params.id
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Bond link retrieved successfully',
        data: result,
    });
});
const markAsCompleteBond = catchAsync(async (req, res) => {
    const result = await bondLinkServices.markAsCompleteBond(
        req.user.profileId,
        req.params.id
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Mark as completed from you end',
        data: result,
    });
});

const rejectBondLink = catchAsync(async (req, res) => {
    // Anti-IDOR: the caller must be a participant. `blockUserIds` is optional and
    // filtered by the service (excludes self, validates participants).
    const result = await bondLinkServices.rejectBondLink(
        req.user.profileId,
        req.params.id,
        req.body?.blockUserIds ?? []
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Trueque rechazado (no concretado)',
        data: result,
    });
});

const BondLinkController = {
    getMyBondLinks,
    createBondLink,
    getSingleBondLink,
    markAsCompleteBond,
    rejectBondLink,
};
export default BondLinkController;
