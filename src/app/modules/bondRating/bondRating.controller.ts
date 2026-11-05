import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import bondRatingServices from './bondRating.service';

const addRating = catchAsync(async (req, res) => {
    const result = await bondRatingServices.addRating(
        req.user.profileId,
        req.body
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Rating added successfully',
        data: result,
    });
});

// D.3 (Tanda 2): vista publica de puntuaciones recibidas de un usuario.
const getPublicRatings = catchAsync(async (req, res) => {
    const result = await bondRatingServices.getPublicRatings(
        req.params.userId,
        req.query,
        req.user.profileId
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Ratings retrieved successfully',
        data: result,
    });
});

const BondRatingController = { addRating, getPublicRatings };
export default BondRatingController;
