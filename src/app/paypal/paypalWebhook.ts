/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-console */
/* Signed PayPal webhook — SOURCE OF TRUTH for crediting. Signature is verified first;
 * crediting is idempotent (unique transactionId), so it is safe alongside the redirect. */
import paypal from '@paypal/checkout-server-sdk';
import axios from 'axios';
import { Request, Response } from 'express';
import config from '../config';
import { ENUM_PAYMENT_PURPOSE } from '../utilities/enum';
import paypalClient from '../utilities/paypal';
import { creditDonation, creditSubscription } from './creditPayment';

// PayPal REST API base (derived from the mode when not set).
const apiBase = (): string =>
    config.paypal.base_url ||
    (config.paypal.mode === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com');

const getAccessToken = async (): Promise<string | null> => {
    try {
        const { data } = await axios.post<any>(
            `${apiBase()}/v1/oauth2/token`,
            'grant_type=client_credentials',
            {
                auth: {
                    username: config.paypal.client_id as string,
                    password: config.paypal.client_secret as string,
                },
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            }
        );
        return data?.access_token || null;
    } catch (e) {
        console.error(
            '[paypal-webhook] no se pudo obtener access token:',
            (e as Error)?.message
        );
        return null;
    }
};

const verifySignature = async (req: Request): Promise<boolean> => {
    const webhookId = config.paypal.webhook_id;
    if (!webhookId) {
        console.error('[paypal-webhook] PAYPAL_WEBHOOK_ID no configurado');
        return false;
    }
    const accessToken = await getAccessToken();
    if (!accessToken) return false;

    try {
        const { data } = await axios.post<any>(
            `${apiBase()}/v1/notifications/verify-webhook-signature`,
            {
                auth_algo: req.headers['paypal-auth-algo'],
                cert_url: req.headers['paypal-cert-url'],
                transmission_id: req.headers['paypal-transmission-id'],
                transmission_sig: req.headers['paypal-transmission-sig'],
                transmission_time: req.headers['paypal-transmission-time'],
                webhook_id: webhookId,
                webhook_event: req.body,
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        return data?.verification_status === 'SUCCESS';
    } catch (e) {
        console.error(
            '[paypal-webhook] verificación de firma falló:',
            (e as Error)?.message
        );
        return false;
    }
};

const paypalWebhook = async (req: Request, res: Response) => {
    // 1) Verify signature; reject when invalid.
    const ok = await verifySignature(req);
    if (!ok) {
        return res
            .status(400)
            .json({ success: false, message: 'Invalid webhook signature' });
    }

    // 2) Process only completed captures. Errors → 500 so PayPal retries
    //    (crediting is idempotent, so a retry is safe).
    try {
        const event = req.body;
        if (event?.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
            const resource = event.resource || {};
            const transactionId: string = resource.id;
            const amount: string = resource?.amount?.value;
            const orderId: string | undefined =
                resource?.supplementary_data?.related_ids?.order_id;

            let customId: string | undefined = resource?.custom_id;
            let purpose: string | undefined;

            // The purpose (subscription/donation) lives in the order's reference_id;
            // read it from the order (same as the capture flow).
            if (orderId) {
                const orderReq = new paypal.orders.OrdersGetRequest(orderId);
                const orderRes = await paypalClient.execute(orderReq);
                const pu = orderRes.result.purchase_units?.[0];
                customId = pu?.custom_id ?? customId;
                purpose = pu?.reference_id;
            }

            if (customId && transactionId) {
                // Defense in depth: these webhooks mount BEFORE sanitizeMongo, so force
                // Mongo query inputs to string (e.g. `{$ne:null}` becomes "[object Object]"
                // and findById matches nothing). The signature is the main barrier.
                const safeCustomId = String(customId);
                const safeTransactionId = String(transactionId);
                if (purpose === ENUM_PAYMENT_PURPOSE.SUBSCRIPTION) {
                    await creditSubscription(
                        safeCustomId,
                        safeTransactionId,
                        amount
                    );
                } else if (purpose === ENUM_PAYMENT_PURPOSE.DONATE) {
                    await creditDonation(
                        safeCustomId,
                        safeTransactionId,
                        amount
                    );
                }
            }
        }
        return res.status(200).json({ success: true });
    } catch (e) {
        console.error('[paypal-webhook] error procesando:', (e as Error)?.message);
        return res
            .status(500)
            .json({ success: false, message: 'Processing error' });
    }
};

export default paypalWebhook;
