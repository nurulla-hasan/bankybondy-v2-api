import { Response } from 'express';
import config from '../config';
import { creditSubscription } from './creditPayment';

// Flujo de captura por redirect del navegador. La acreditación real vive en
// creditSubscription (idempotente), compartida con el webhook firmado.
const handleSubscriptionPaymentSuccess = async (
    res: Response,
    userId: string,
    transactionId: string,
    amount: number
) => {
    const successUrl = `${config.paypal.donation_success_url}?userId=${userId}&transaction_id=${transactionId}&amount=${amount}`;

    const result = await creditSubscription(userId, transactionId, amount);
    if (result.status === 'ignored' || result.status === 'not-applied') {
        // `not-applied` = SE COBRÓ y el plan no se pudo aplicar (ya tenía uno
        // igual o mayor, o el usuario no existe). Antes caía en el `else` y se
        // iba a la pantalla de ÉXITO: alguien pagaba, no recibía nada, y leía
        // "Pago recibido".
        //
        // Ninguna de las dos pantallas es exactamente la verdad —"Pago cancelado"
        // tampoco lo es, porque el cobro ocurrió— pero la de cancelación es la
        // que NO afirma que la suscripción se aplicó, y encima invita a contactar
        // a soporte, que es justo lo que esta persona necesita hacer. La plata
        // quedó registrada en `Transaction` y el admin tiene la palanca.
        //
        // Desde que `purchaseSubscription` rechaza comprar un plan igual o menor,
        // este camino sólo se alcanza con un link de checkout viejo.
        // eslint-disable-next-line no-console
        console.error(
            `Subscription: not credited (${result.status}):`,
            result.reason,
            transactionId,
            'usuario:',
            userId
        );
        return res.redirect(`${config.paypal.donation_cancel_url}`);
    }
    return res.redirect(successUrl);
};

export default handleSubscriptionPaymentSuccess;
