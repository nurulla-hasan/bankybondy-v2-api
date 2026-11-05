/* eslint-disable @typescript-eslint/no-explicit-any */
// export default capturePayPalPayment;

import paypal from '@paypal/checkout-server-sdk';
import { Request } from 'express';
import config from '../config';
import { ENUM_PAYMENT_PURPOSE } from '../utilities/enum';
import paypalClient from '../utilities/paypal';
import handleDonationPaymentSuccess from './handleDonationPaymentSuccess';
import handleSubscriptionPaymentSuccess from './handleSubscriptionPayment';
//
const capturePayPalPayment = async (req: Request, res: any) => {
    const orderId = req.query.token;
    try {
        const captureRequest: any = new paypal.orders.OrdersCaptureRequest(
            orderId as string
        );
        // capture payment
        captureRequest.requestBody({});
        const captureResponse = await paypalClient.execute(captureRequest);
        if (captureResponse.result.status !== 'COMPLETED') {
            console.error('Payment Capture Failed:', captureResponse);
            return res.redirect(`${config.paypal.donation_cancel_url}`);
        }
        const orderRequest = new paypal.orders.OrdersGetRequest(
            orderId as string
        );
        const orderResponse = await paypalClient.execute(orderRequest);

        const purchaseUnit = orderResponse.result.purchase_units[0];
        const id = purchaseUnit.custom_id || 'UNKNOWN_CAMPAIGN';
        const paymentPurpose = purchaseUnit.reference_id || 'UNKNOWN_PURPOSE';
        // Idempotencia con el webhook: PAYMENT.CAPTURE.COMPLETED usa el CAPTURE id
        // (resource.id). Acá `captureResponse.result.id` es el ORDER id (distinto),
        // por lo que ambos flujos creaban Transaction distintas y NO deduplicaban.
        // Usamos el capture id real (con fallback defensivo al order id).
        const captureId =
            captureResponse.result?.purchase_units?.[0]?.payments?.captures?.[0]
                ?.id;
        const transactionId = captureId || captureResponse.result.id;
        const amount = purchaseUnit.amount.value;

        if (paymentPurpose === ENUM_PAYMENT_PURPOSE.DONATE) {
            await handleDonationPaymentSuccess(res, id, transactionId, amount);
        } else if (paymentPurpose === ENUM_PAYMENT_PURPOSE.SUBSCRIPTION) {
            await handleSubscriptionPaymentSuccess(
                res,
                id,
                transactionId,
                amount
            );
        } else {
            // Propósito desconocido: no colgar la respuesta, redirigir a cancel.
            return res.redirect(`${config.paypal.donation_cancel_url}`);
        }
    } catch (error) {
        console.error('PayPal Capture Error:', error);
        return res.redirect(`${config.paypal.donation_cancel_url}`);
    }
};

export default capturePayPalPayment;
