import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import recommendedUserServices from './recommendedUser.service';

// ⚠️ DORMIDO — NO RUTEAR SIN BLINDAR. Este handler hace insertMany(req.body) sin
// auth, sin whitelist y sin validación. HOY no está montado en recommendedUser.routes
// (solo GET /get, con auth), así que NO es explotable. Si algún día se lo conecta a
// un POST, hay que exigir auth + validar/whitelistear el body ANTES: tal cual está,
// re-abriría el P0 (siembra anónima masiva en RecommendedUser). El feature queda
// dormido a propósito (no se borra); solo NO conectar sin blindar primero.
const createRecommendedUsers = catchAsync(async (req, res) => {
    const result = await recommendedUserServices.createRecommendedUsers(
        req.body
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Profile updated successfully',
        data: result,
    });
});

const getRecommendedUsers = catchAsync(async (req, res) => {
    const result = await recommendedUserServices.getRecommendedUsers(req.query);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Recommended user retrieved successfully',
        data: result,
    });
});

const RecommendedUserController = {
    createRecommendedUsers,
    getRecommendedUsers,
};
export default RecommendedUserController;
