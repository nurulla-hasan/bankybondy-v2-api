/* Cliente configurado del SDK v2 de MercadoPago.
 * Se reutiliza en el servicio (creación de preferencias) y en el webhook
 * (consulta de pagos). El access token vive en config.mercadopago. */
import { MercadoPagoConfig } from 'mercadopago';
import config from '../config';

export const mpClient = new MercadoPagoConfig({
    accessToken: config.mercadopago.access_token as string,
});
