import { Response } from 'express';
import config from '../config';
import { creditDonation } from './creditPayment';

// Flujo de captura por redirect del navegador. La acreditación real vive en
// creditDonation (idempotente), compartida con el webhook firmado.
const handleDonationPaymentSuccess = async (
    res: Response,
    donationId: string,
    transactionId: string,
    amount: number
) => {
    const successUrl = `${config.paypal.donation_success_url}?donationId=${donationId}&transaction_id=${transactionId}&amount=${amount}`;

    const result = await creditDonation(donationId, transactionId, amount);
    if (result.status === 'ignored') {
        return res.redirect(`${config.paypal.donation_cancel_url}`);
    }
    return res.redirect(successUrl);
};

export default handleDonationPaymentSuccess;
