import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import recommendedUserServices from './recommendedUser.service';

// DORMANT — DO NOT ROUTE WITHOUT HARDENING. This handler does insertMany(req.body)
// with no auth, no whitelist and no validation. It is NOT mounted in
// recommendedUser.routes today (only the authed GET /get), so it is not
// exploitable. If it is ever wired to a POST, require auth and validate/whitelist
// the body FIRST: as-is it would reopen the P0 (mass anonymous seeding). The
// feature is dormant on purpose (do not delete); just do not connect it unhardened.
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
