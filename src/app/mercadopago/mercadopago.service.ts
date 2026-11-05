/* Servicio de MercadoPago (Checkout Pro).
 * Crea una Preference y devuelve la URL de pago (init_point), en paralelo
 * al flujo de PayPal. MercadoPago cobra en la moneda configurada (ARS por
 * defecto), por eso las suscripciones se identifican por tipo de plan en el
 * external_reference y NO por importe. */
import { Preference } from 'mercadopago';
import httpStatus from 'http-status';
import config from '../config';
import AppError from '../error/appError';
import { mpClient } from './mpClient';
import { esTipoPlan, PLANES } from '../modules/normalUser/subscriptionPlans';
import { usdToPesos } from './dollarRate';

// URLs de retorno del navegador (comunes a suscripción y donación).
const backUrls = {
    success: config.mercadopago.success_url as string,
    failure: config.mercadopago.failure_url as string,
    pending: config.mercadopago.pending_url as string,
};

// MP rechaza la preferencia si se pide auto_return sin back_urls.success.
// Sólo activamos auto_return cuando hay URL de éxito configurada.
const autoReturn = backUrls.success ? ('approved' as const) : undefined;

export const createSubscriptionPreference = async (
    userId: string,
    type: 'Standard' | 'Premium'
): Promise<{ url: string }> => {
    // Objetivo en dólares del plan → se convierte a pesos con la cotización del
    // día. El precio sale de `subscriptionPlans`, que es la MISMA fuente que usa
    // el endpoint de precios que ve el usuario: el número que se muestra y el que
    // se cobra no pueden divergir porque son el mismo.
    if (!esTipoPlan(type) || PLANES[type].usdMercadopago <= 0) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'MercadoPago price not configured for this plan'
        );
    }
    const usd = PLANES[type].usdMercadopago;

    // Precio en pesos del día (fuente de verdad del servidor).
    const price = await usdToPesos(usd);

    const result = await new Preference(mpClient).create({
        body: {
            items: [
                {
                    id: type,
                    title: 'Bankybondy ' + type,
                    quantity: 1,
                    unit_price: price,
                    currency_id: config.mercadopago.currency,
                },
            ],
            // El propósito, el destinatario y EL PRECIO ESPERADO viajan en el
            // external_reference: SUBSCRIPTION:<tipo>:<userId>:<pesosEsperados>
            //
            // El cuarto campo es la banda de cordura del monto. Sin él, el webhook
            // sólo podía validar `amount > 0`: acreditaba Premium por un pago de
            // un peso. Estimarlo del lado del webhook (recalculando la cotización)
            // no sirve, porque el blue se mueve y esa preferencia puede pagarse
            // horas o días después → habría que usar una banda tan ancha que no
            // filtraría nada. Mandando el precio EXACTO que se cotizó al crear la
            // preferencia, la comprobación es exacta y no depende de nada más.
            external_reference:
                'SUBSCRIPTION:' + type + ':' + userId + ':' + price,
            back_urls: backUrls,
            ...(autoReturn ? { auto_return: autoReturn } : {}),
            notification_url: config.mercadopago.webhook_url,
            // LA PREFERENCIA CADUCA, y esto arregla dos cosas a la vez.
            //
            // (1) El precio: este `init_point` lleva adentro un precio en pesos
            // cotizado AHORA. Sin vencimiento, ese link sirve para siempre —MP no
            // expira nada por default— así que alguien podía pagar dentro de seis
            // meses el precio de hoy.
            //
            // (2) La banda de monto: las preferencias creadas ANTES de que el
            // precio esperado viajara en el external_reference no se pueden
            // validar (no traen el cuarto campo) y se acreditan sin banda. Un
            // comentario anterior afirmaba que "la ventana se cierra sola cuando
            // caducan" — y no caducaban. Ahora sí, y la afirmación es cierta.
            //
            // 24 h es holgado para decidir un pago y corto para que el precio no
            // se despegue de la cotización.
            expires: true,
            expiration_date_to: new Date(
                Date.now() +
                    (Number(process.env.MP_PREFERENCE_HOURS) || 24) * 3600_000
            ).toISOString(),
            // UN SOLO PAGO, SIN CUOTAS (decisión de Emilio, 11/9).
            //
            // Sin esto, Checkout Pro ofrece las cuotas que tenga habilitadas la
            // cuenta, y en las cuotas con interés **el costo financiero lo paga el
            // comprador**: alguien veía "$X" en el botón, elegía 6 cuotas y
            // terminaba pagando bastante más. Contra un producto que promete que
            // el precio mostrado es el que se arma en el checkout, eso no es un
            // redondeo.
            //
            // `installments: 1` deja un único pago, que además es coherente con lo
            // que la suscripción ES: se paga una vez y no vence.
            payment_methods: {
                installments: 1,
            },
        },
    });

    return { url: result.init_point as string };
};

export const createDonationPreference = async (
    donationId: string,
    amount: number
): Promise<{ url: string }> => {
    // El monto ingresado (en dólares) se convierte a pesos del día.
    const price = await usdToPesos(amount);
    const result = await new Preference(mpClient).create({
        body: {
            items: [
                {
                    id: 'donation',
                    title: 'Donación Bankybondy',
                    quantity: 1,
                    unit_price: price,
                    currency_id: config.mercadopago.currency,
                },
            ],
            // DONATE:<donationId>
            external_reference: 'DONATE:' + donationId,
            back_urls: backUrls,
            ...(autoReturn ? { auto_return: autoReturn } : {}),
            notification_url: config.mercadopago.webhook_url,
        },
    });

    return { url: result.init_point as string };
};
