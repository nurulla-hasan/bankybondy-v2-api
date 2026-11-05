/* eslint-disable no-console */
/* Webhook de MercadoPago — FUENTE DE VERDAD de la acreditación.
 *
 * A diferencia del redirect del navegador (que puede no completarse si el
 * usuario cierra la pestaña), MercadoPago envía esta notificación
 * server-to-server y la firma con HMAC-SHA256. Verificamos la firma y recién
 * ahí consultamos el pago y acreditamos. La acreditación es idempotente
 * (Transaction.transactionId único), así que es seguro que dispare junto con
 * el redirect: solo uno acredita.
 *
 * Configuración: MP_WEBHOOK_SECRET (clave secreta del webhook del panel de MP).
 */
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

// Comparación en tiempo constante (evita timing attacks). Si difieren las
// longitudes, timingSafeEqual lanza, por eso se controla antes.
const safeEqual = (a: string, b: string): boolean => {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
};

// Headers/query pueden llegar como string, string[] o undefined. Normaliza a un
// único string (toma el primero si es array): evita type-confusion al firmar.
const firstString = (value: unknown): string => {
    if (Array.isArray(value)) return firstString(value[0]);
    if (typeof value === 'string') return value;
    if (value == null) return '';
    return String(value);
};

// Verifica la firma HMAC del header x-signature contra el manifest de MP.
const verifySignature = (req: Request, dataId: string): boolean => {
    const secret = config.mercadopago.webhook_secret;
    // Sin secret: en PRODUCCIÓN se rechaza (fail-closed); en dev/setup se deja
    // pasar para poder probar antes de configurarlo.
    // Fail-CLOSED incondicional: sin secret NUNCA se acepta (antes en no-prod se
    // dejaba pasar sin firma; si el deploy no exportaba NODE_ENV=production era un
    // agujero para acreditar pagos falsos). Mismo criterio que PayPal con webhook_id.
    if (!secret) {
        console.error(
            '[mercadopago-webhook] MP_WEBHOOK_SECRET no configurado: se rechaza la notificación (fail-closed)'
        );
        return false;
    }

    const xSignature = firstString(req.headers['x-signature']);
    const xRequestId = firstString(req.headers['x-request-id']);
    if (!xSignature) return false;

    // x-signature tiene formato: "ts=<timestamp>,v1=<hash>"
    let ts = '';
    let v1 = '';
    for (const part of xSignature.split(',')) {
        const [key, value] = part.split('=');
        const k = key?.trim();
        if (k === 'ts') ts = value?.trim();
        else if (k === 'v1') v1 = value?.trim();
    }
    if (!ts || !v1) return false;
    // NO se rechaza por antigüedad del `ts`: MP reintenta con la MISMA firma
    // durante horas/días si no recibe 2xx, así que una ventana corta tiraría
    // cobros legítimos (y el skew de reloj rechazaría TODO). El replay ya está
    // neutralizado por la idempotencia de Transaction.transactionId (único).

    // Según MP: si data.id es alfanumérico va en minúsculas; los campos
    // ausentes se omiten del manifest.
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
    // 1) Identificar el pago. Puede venir por query (?data.id=... / ?id=...)
    //    o en el body (data.id). El tipo/topic indica qué recurso notifican.
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

    // Solo procesamos notificaciones de pago; el resto se ignora con 200.
    if (type !== 'payment') {
        return res.status(200).json({ success: true });
    }

    // 2) Verificar firma (si hay secret configurado).
    if (!verifySignature(req, dataId)) {
        return res.status(401).json({ success: false });
    }

    // 3) Consultar el pago y acreditar. Errores → 500 para que MP reintente
    //    (la acreditación es idempotente, así que es seguro).
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

        // Moneda inesperada: no acreditar (acuse 200 para que MP no reintente).
        if (currencyId && currencyId !== config.mercadopago.currency) {
            console.error(
                `[mercadopago-webhook] moneda inesperada ${currencyId} para pago ${paymentId}`
            );
            return res.status(200).json({ success: true });
        }

        // Monto no positivo: no acreditar (acuse 200 para que MP no reintente).
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
                    // Misma fuente que la guarda de moneda de arriba (default 'ARS':
                    // MP cobra en pesos, no en dólares como PayPal), para que el
                    // check y lo que se guarda en Transaction.currency no diverjan.
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

                // ── BANDA DE CORDURA DEL MONTO ──────────────────────────────
                //
                // Hasta acá lo único que se validaba del importe era `amount > 0`:
                // el plan se acreditaba por el `planType` del external_reference,
                // así que un pago aprobado de UN PESO otorgaba Premium igual.
                //
                // El precio exacto que se cotizó al crear la preferencia viaja en
                // el cuarto campo, así que la comprobación no es una estimación.
                // El piso admite un margen (default 90%) por si MP redondea o
                // aplica algún ajuste chico.
                //
                // LA BANDA ES DE UN SOLO LADO, a propósito: sólo se rechaza pagar
                // DE MENOS. Pagar de más no es un ataque contra nosotros y
                // rechazarlo sería dejar mal a alguien que pagó.
                //
                // Las preferencias VIEJAS (creadas antes de este cambio) no traen
                // el cuarto campo. Se acreditan como siempre: no se le puede
                // cambiar las reglas a un pago que ya está en vuelo.
                //
                // Y esa ventana SÍ se cierra sola, pero no porque MP expire nada
                // por su cuenta —no lo hace— sino porque desde ahora las
                // preferencias se crean con `expires` + `expiration_date_to`
                // (24 h). Las que quedaron sueltas de antes son las emitidas en
                // las horas previas al deploy, y nada más.
                // CLAMPEADO a (0, 1]. Sin techo, un `MP_AMOUNT_MIN_RATIO=1.5`
                // —un typo perfectamente plausible— dejaba TODOS los pagos
                // legítimos por debajo de la banda: nadie recibía nada, con 200 y
                // sin dejar Transaction. El piso de 0.01 evita el otro extremo
                // (una banda de cero, que es no tener banda).
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
                        // 200: no tiene sentido que MP reintente, el monto no va a
                        // cambiar. Queda el log y el pago registrado en MP; si fuera
                        // legítimo, se resuelve con la palanca del dashboard.
                        return res.status(200).json({ success: true });
                    }
                }

                if (planType && userId) {
                    // Misma fuente de moneda que creditDonation (arriba).
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
