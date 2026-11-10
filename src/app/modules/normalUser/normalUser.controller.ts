/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import { getCloudFrontUrl } from '../../helper/mutler-s3-uploader';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import NormalUserServices from './normalUser.services';

const updateUserProfile = catchAsync(async (req, res) => {
    const file: any = req.files?.profile_image;
    if (req.files?.profile_image) {
        req.body.profile_image = getCloudFrontUrl(file[0].key);
    }
    const file2: any = req.files?.profile_cover;
    if (req.files?.profile_cover) {
        req.body.cover_image = getCloudFrontUrl(file2[0].key);
    }
    const result = await NormalUserServices.updateUserProfile(
        req.user.profileId,
        req.body
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Profile updated successfully',
        data: result,
    });
});

const getAllUser = catchAsync(async (req, res) => {
    const result = await NormalUserServices.getAllUser(req.user, req.query);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'User retrieved successfully',
        data: result,
    });
});

const getSingleUser = catchAsync(async (req, res) => {
    const result = await NormalUserServices.getSingleUser(
        req.user,
        req.params.id
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'User retrieved successfully',
        data: result,
    });
});
const updateLocation = catchAsync(async (req, res) => {
    const result = await NormalUserServices.updateLocation(
        req.user.profileId,
        req.body
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Location updated successfully',
        data: result,
    });
});

const purchaseSubscription = catchAsync(async (req, res) => {
    const result = await NormalUserServices.purchaseSubscription(
        req.user.profileId,
        req.body.type,
        req.body.provider
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Payment link generated for subscription',
        data: result,
    });
});

const updateBondsVisibility = catchAsync(async (req, res) => {
    const result = await NormalUserServices.updateBondsVisibility(
        req.user.profileId,
        req.body.bondsPublic
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Bonds visibility updated',
        data: result,
    });
});

const updatePeopleVisibility = catchAsync(async (req, res) => {
    const result = await NormalUserServices.updatePeopleVisibility(
        req.user.profileId,
        req.body.listedInPeople
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'People visibility updated',
        data: result,
    });
});

// Plan prices: both real ones (PayPal in USD, MercadoPago in the day's pesos) using the
// same quote as billing. Public on purpose: the pricing page shows them logged out.
const getSubscriptionPrices = catchAsync(async (req, res) => {
    const result = await NormalUserServices.getSubscriptionPrices();
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Subscription prices',
        data: result,
    });
});

// Manual plan override (admin): the only path where a plan can go DOWN.
const setSubscriptionByAdmin = catchAsync(async (req, res) => {
    const result = await NormalUserServices.setSubscriptionByAdmin(
        req.user.id,
        req.params.id,
        req.body.type,
        req.body.reason
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Subscription updated',
        data: result,
    });
});

const NormalUserController = {
    updateUserProfile,
    getAllUser,
    getSingleUser,
    purchaseSubscription,
    getSubscriptionPrices,
    setSubscriptionByAdmin,
    updateLocation,
    updateBondsVisibility,
    updatePeopleVisibility,
};

export default NormalUserController;
