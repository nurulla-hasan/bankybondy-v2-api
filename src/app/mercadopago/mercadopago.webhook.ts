/* eslint-disable no-console */
/* MercadoPago webhook — SOURCE OF TRUTH for crediting: signed, server-to-server,
 * idempotent via unique Transaction.transactionId. Config: MP_WEBHOOK_SECRET. */
import { Payment } from 'mercadopago';
import crypto from 'crypto';
import { Request, Response } from 'express';
import config from '../config';
import {
    creditDonation,
    creditSubscriptionByType,
    type TCurrency,
} from '../paypal/creditPayment';
import { mpClient } from './mpClient';

// Constant-time compare (avoids timing attacks); timingSafeEqual throws on
// length mismatch, hence the check.
const safeEqual = (a: string, b: string): boolean => {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
};

// Headers/query can be string, string[] or undefined; normalize to one string to
// avoid type confusion in the signature manifest.
const firstString = (value: unknown): string => {
    if (Array.isArray(value)) return firstString(value[0]);
    if (typeof value === 'string') return value;
    if (value == null) return '';
    return String(value);
};

// Verifies the HMAC x-signature against MP's manifest.
const verifySignature = (req: Request, dataId: string): boolean => {
    const secret = config.mercadopago.webhook_secret;
    // Fail-CLOSED unconditionally: without a secret nothing is accepted (the old
    // non-prod bypass was a hole for forged payments). Same as PayPal webhook_id.
    if (!secret) {
        console.error(
            '[mercadopago-webhook] MP_WEBHOOK_SECRET no configurado: se rechaza la notificación (fail-closed)'
        );
        return false;
    }

    const xSignature = firstString(req.headers['x-signature']);
    const xRequestId = firstString(req.headers['x-request-id']);
    if (!xSignature) return false;

    // x-signature format: "ts=<timestamp>,v1=<hash>"
    let ts = '';
    let v1 = '';
    for (const part of xSignature.split(',')) {
        const [key, value] = part.split('=');
        const k = key?.trim();
        if (k === 'ts') ts = value?.trim();
        else if (k === 'v1') v1 = value?.trim();
    }
    if (!ts || !v1) return false;
    // `ts` age is NOT checked: MP retries with the SAME signature for hours/days,
    // so a window would drop legit charges. Replay is neutralized by the unique
    // Transaction.transactionId.

    // Per MP: alphanumeric data.id goes lowercase; absent fields are omitted.
    const idPart = dataId ? `id:${dataId.toLowerCase()};` : '';
    const reqPart = xRequestId ? `request-id:${xRequestId};` : '';
    const manifest = `${idPart}${reqPart}ts:${ts};`;
    const computed = crypto
        .createHmac('sha256', secret)
        .update(manifest)
        .digest('hex');

    return safeEqual(computed, v1);
};

const mercadopagoWebhook = async (req: Request, res: Response) => {
    // 1) Identify the payment: id via query or body; type/topic says what it is.
    const dataId =
        firstString(req.query['data.id']) ||
        (req.body?.data?.id != null ? String(req.body.data.id) : '') ||
        firstString(req.query.id) ||
        '';

    const type =
        firstString(req.query.type) ||
        firstString(req.query.topic) ||
        req.body?.type ||
        req.body?.topic;

    // Only payment notifications are processed; everything else is acked with 200.
    if (type !== 'payment') {
        return res.status(200).json({ success: true });
    }

    // 2) Verify signature (always fails without a configured secret).
    if (!verifySignature(req, dataId)) {
        return res.status(401).json({ success: false });
    }

    // 3) Fetch payment and credit. Errors -> 500 so MP retries (idempotent).
    try {
        if (!dataId) {
            return res.status(200).json({ success: true });
        }

        const payment = await new Payment(mpClient).get({ id: dataId });
        const status = payment.status;
        const externalReference = payment.external_reference;
        const amount = Number(payment.transaction_amount);
        const currencyId = firstString(
            (payment as { currency_id?: unknown }).currency_id
        );
        const paymentId = String(payment.id);

        // Unexpected currency: do not credit (200 so MP stops retrying).
        if (currencyId && currencyId !== config.mercadopago.currency) {
            console.error(
                `[mercadopago-webhook] moneda inesperada ${currencyId} para pago ${paymentId}`
            );
            return res.status(200).json({ success: true });
        }

        // Non-positive amount: do not credit (200 so MP stops retrying).
        if (!(amount > 0)) {
            console.error(
                `[mercadopago-webhook] monto inválido ${payment.transaction_amount} para pago ${paymentId}`
            );
            return res.status(200).json({ success: true });
        }

        if (status === 'approved' && externalReference) {
            if (externalReference.startsWith('DONATE:')) {
                // DONATE:<donationId>
                const donationId = externalReference.slice('DONATE:'.length);
                if (donationId) {
                    // Same currency source as the check above, so the check and what
                    // lands in Transaction.currency never diverge.
                    await creditDonation(
                        donationId,
                        paymentId,
                        amount,
                        config.mercadopago.currency as TCurrency
                    );
                }
            } else if (externalReference.startsWith('SUBSCRIPTION:')) {
                // SUBSCRIPTION:<planType>:<userId>:<pesosEsperados>
                const parts = externalReference.split(':');
                const planType = parts[1];
                const userId = parts[2];
                const esperado = Number(parts[3]);

                // AMOUNT BAND. Plan comes from planType, so without this a 1-peso
                // approved payment would grant Premium. The exact quoted price rides
                // in the 4th field. One-sided on purpose: only underpayment is
                // rejected, overpaying is not an attack. Old preferences without it
                // are credited as before and die out via their 24h `expires`.
                // Clamped to (0, 1] so a typo like MP_AMOUNT_MIN_RATIO=1.5 cannot
                // reject every legit payment, nor 0 disable the band.
                const ratioMin = Math.min(
                    Math.max(Number(process.env.MP_AMOUNT_MIN_RATIO) || 0.9, 0.01),
                    1
                );
                if (Number.isFinite(esperado) && esperado > 0) {
                    if (amount < esperado * ratioMin) {
                        console.error(
                            `[mercadopago-webhook] monto insuficiente para ${planType}: ` +
                                `pagó ${amount}, esperado ${esperado} (pago ${paymentId}, usuario ${userId}). NO se acredita.`
                        );
                        // 200: retrying won't change the amount. Logged and recorded
                        // in MP; if legit, resolve via the dashboard lever.
                        return res.status(200).json({ success: true });
                    }
                }

                if (planType && userId) {
                // Same currency source as creditDonation above.
                    await creditSubscriptionByType(
                        userId,
                        paymentId,
                        planType,
                        amount,
                        config.mercadopago.currency as TCurrency
                    );
                }
            }
        }

        return res.status(200).json({ success: true });
    } catch (e) {
        console.error(
            '[mercadopago-webhook] error procesando:',
            (e as Error)?.message
        );
        return res
            .status(500)
            .json({ success: false, message: 'Processing error' });
    }
};

export default mercadopagoWebhook;
