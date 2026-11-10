import { Response } from 'express';
import config from '../config';
import { creditSubscription } from './creditPayment';

// Browser-redirect capture flow. The real crediting lives in creditSubscription
// (idempotent) and is shared with the signed webhook.
const handleSubscriptionPaymentSuccess = async (
    res: Response,
    userId: string,
    transactionId: string,
    amount: number
) => {
    const successUrl = `${config.paypal.donation_success_url}?userId=${userId}&transaction_id=${transactionId}&amount=${amount}`;

    const result = await creditSubscription(userId, transactionId, amount);
    if (result.status === 'ignored' || result.status === 'not-applied') {
        // `not-applied` = CHARGED but the plan could not be applied (already had an
        // equal-or-better plan, or the user is gone). It used to fall through to the
        // SUCCESS screen: the user paid, got nothing, and read "Payment received".
        // The cancel screen does not claim the subscription applied and invites
        // contacting support, which is what they need. The charge is recorded in
        // `Transaction` and the admin has the lever. Reachable only with an old
        // checkout link, since `purchaseSubscription` rejects equal/lower plans.
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
