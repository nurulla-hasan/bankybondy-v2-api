import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import { DonateService } from './donate.service';
import sendResponse from '../../utilities/sendResponse';

export const createDonate = catchAsync(async (req: Request, res: Response) => {
    const result = await DonateService.donate(
        req.user.profileId,
        req.body.amount,
        req.body.provider
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Checkout session created',
        data: result,
    });
});

export const getAllDonates = catchAsync(async (req: Request, res: Response) => {
    const result = await DonateService.getAllDonner(req.query);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Donations retrieved successfully',
        data: result,
    });
});
