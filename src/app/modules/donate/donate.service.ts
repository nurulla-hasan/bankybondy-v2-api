/* eslint-disable @typescript-eslint/no-explicit-any */
import paypal from '@paypal/checkout-server-sdk';
import httpStatus from 'http-status';
import QueryBuilder from '../../builder/QueryBuilder';
import config from '../../config';
import AppError from '../../error/appError';
import { createDonationPreference } from '../../mercadopago/mercadopago.service';
import { ENUM_PAYMENT_PURPOSE } from '../../utilities/enum';
import paypalClient from '../../utilities/paypal';
import { ENUM_DONATE_STATUS } from './donate.enum';
import { Donate } from './donate.model';
const donate = async (userId: string, amount: number, provider?: string) => {
    const result = await Donate.create({ user: userId, amount: amount });

    // MercadoPago path (parallel to PayPal): the donation stays Unpaid until the
    // webhook confirms it; return the Checkout Pro URL.
    if (provider === 'mercadopago') {
        return createDonationPreference(result._id.toString(), amount);
    }
    // Stripe was removed: never used in production.

    const totalAmount = amount;

    try {
        const request = new paypal.orders.OrdersCreateRequest();
        request.prefer('return=representation');
        request.requestBody({
            intent: 'CAPTURE',
            purchase_units: [
                {
                    amount: {
                        currency_code: 'USD',
                        value: totalAmount.toFixed(2),
                    },
                    description: `Payment for Donation: ${result._id}`,
                    custom_id: result._id.toString(),
                    reference_id: ENUM_PAYMENT_PURPOSE.DONATE,
                },
            ],
            // application_context: {
            //     brand_name: 'Your Business Name',
            //     landing_page: 'LOGIN',
            //     user_action: 'PAY_NOW',
            //     return_url: `${config.paypal.payment_capture_url}`,
            //     cancel_url: `${config.paypal.donation_cancel_url}`,
            // },
            application_context: {
                // Shown by PayPal to the donor. Was the sample "Your Business Name".
                brand_name: 'Bankybondy',
                landing_page: 'BILLING', // allows credit/debit card without login
                user_action: 'PAY_NOW',
                return_url: config.paypal.payment_capture_url,
                cancel_url: config.paypal.donation_cancel_url,
            },
        });

        const response = await paypalClient.execute(request);
        const approvalUrl = response.result.links.find(
            (link: any) => link.rel === 'approve'
        )?.href;

        if (!approvalUrl) {
            throw new AppError(
                httpStatus.INTERNAL_SERVER_ERROR,
                'PayPal payment creation failed: No approval URL found'
            );
        }

        return { url: approvalUrl };
    } catch (error) {
        console.error('PayPal Payment Error:', error);
        throw new AppError(
            httpStatus.INTERNAL_SERVER_ERROR,
            'Failed to create PayPal order'
        );
    }
};

const getAllDonner = async (query: Record<string, unknown>) => {
    const resultQuery = new QueryBuilder(
        Donate.find({ status: ENUM_DONATE_STATUS.Paid }).populate({
            path: 'user',
        }),
        query
    )
        .search(['name'])
        .fields()
        .filter()
        .paginate()
        .sort();

    const result = await resultQuery.modelQuery;
    const meta = await resultQuery.countTotal();
    return {
        meta,
        result,
    };
};

export const DonateService = {
    donate,
    getAllDonner,
};
