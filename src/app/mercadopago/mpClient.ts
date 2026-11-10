/* Configured MercadoPago SDK v2 client, shared by the service (preferences) and the
 * webhook (payment lookups). The access token comes from config.mercadopago. */
import { MercadoPagoConfig } from 'mercadopago';
import config from '../config';

export const mpClient = new MercadoPagoConfig({
    accessToken: config.mercadopago.access_token as string,
});
