import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import originalSendResponse from '../../utilities/sendResponse';
import bondLinkServices from './bondLink.service';
import { publicBondData } from '../bondRequest/bondIdentity';

const sendResponse: typeof originalSendResponse = (res, payload) =>
    originalSendResponse(res, { ...payload, data: publicBondData(payload.data) });

const createBondLink = catchAsync(async (req, res) => {
    // Anti-IDOR: el servicio verifica que quien llama (req.user.profileId) sea
    // uno de los participantes. No se confía en el body para saber "quién crea".
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
    // Anti-IDOR: el servicio verifica que el caller (req.user.profileId) sea
    // participante. `blockUserIds` es opcional y el servicio lo filtra (excluye al
    // propio usuario + valida que sean participantes del trueque).
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
