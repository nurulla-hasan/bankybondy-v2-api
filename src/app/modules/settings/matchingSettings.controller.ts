import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import { readMatchingSettingsFresh, updateMatchingSettings } from './matchingSettings.service';

const getMatching = catchAsync(async (_req, res) => {
    const snapshot = await readMatchingSettingsFresh();
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Matching settings retrieved successfully',
        data: snapshot,
    });
});

const updateMatching = catchAsync(async (req, res) => {
    const snapshot = await updateMatchingSettings(req.body, req.user.id);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Matching settings updated successfully',
        data: snapshot,
    });
});

export const matchingSettingsController = { getMatching, updateMatching };
