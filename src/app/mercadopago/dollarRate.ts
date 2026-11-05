/* Cotización del dólar para los precios de MercadoPago en ARS.
 *
 * Los planes tienen un objetivo en dólares (MP_USD_STANDARD / MP_USD_PREMIUM);
 * al crear la preferencia convertimos ese objetivo a pesos con la cotización
 * del día (dolarapi.com). Así el precio en pesos queda siempre al día sin tocar
 * variables a mano.
 *
 * Robustez: la cotización se cachea 1 hora. Si la API falla, se usa la última
 * cotización conocida; si no hay ninguna, una cotización de respaldo del .env
 * (MP_FALLBACK_RATE). Si tampoco hay respaldo, se aborta con error claro (no se
 * crea una preferencia con precio inválido). */
import axios from 'axios';
import httpStatus from 'http-status';
import config from '../config';
import AppError from '../error/appError';
import { errorLogger } from '../shared/logger';

// DOS FECHAS, NO UNA, y la diferencia importa:
//   · `at` es el SELLO de la caché: decide cuándo se vuelve a intentar. Se
//     re-estampa al servir una cotización vieja, para no pagar el axios de 5 s en
//     cada request mientras dolarapi esté caído.
//   · `obtenidoAt` es cuándo se OBTUVO de verdad esa cotización. No se toca nunca
//     en el re-sello.
// Separarlas las pidió la segunda ronda del panel: con una sola, el log de abajo
// medía `now - at` y el re-sello lo clavaba en ~60 minutos para siempre — a tres
// días de caída el log de PAGOS seguía diciendo 60, o sea que el único síntoma
// que este archivo tiene mentía justo cuando más hacía falta.
let cached: { rate: number; at: number; obtenidoAt: number } | null = null;
const TTL_MS = 60 * 60 * 1000; // 1 hora

// Devuelve cuántos pesos vale 1 dólar (precio de venta) según el tipo de dólar
// configurado (blue por defecto).
export const getDollarRate = async (): Promise<number> => {
    const now = Date.now();
    if (cached && now - cached.at < TTL_MS) return cached.rate;

    const type = config.mercadopago.dollar_rate_type || 'blue';
    try {
        const { data } = await axios.get(
            `https://dolarapi.com/v1/dolares/${type}`,
            { timeout: 5000 }
        );
        const rate = Number((data as { venta?: number })?.venta);
        if (Number.isFinite(rate) && rate > 0) {
            cached = { rate, at: now, obtenidoAt: now };
            return rate;
        }
        throw new Error('cotización inválida');
    } catch (error) {
        // Fallback: última cotización conocida, luego respaldo de .env.
        //
        // SE REFRESCA `at` AL DEVOLVER LA CACHÉ VIEJA. Sin esto la caché seguía
        // vencida en la llamada siguiente, así que mientras dolarapi estuviera
        // caído CADA request volvía a pagar el axios de 5 s. Es el mismo sangrado
        // que el bloque de abajo declara haber cerrado, pero por el camino que
        // realmente se recorre: al de abajo sólo se llega si NUNCA hubo
        // cotización, y con el servicio andando desde hace meses siempre hay.
        //
        // DOS PRECISIONES DEL PANEL DEL 26/9, porque la versión anterior de este
        // comentario decía dos cosas que no eran ciertas:
        //   · "una llamada por hora" vale por RÁFAGA, no en absoluto: no hay
        //     single-flight (entre el chequeo de arriba y el axios hay un await),
        //     así que varias llamadas concurrentes salen todas. No se agrega
        //     single-flight: a 46 usuarios no paga la complejidad.
        //   · "sirve un precio de hasta una hora de antigüedad" es FALSO. Lo que
        //     se refresca es el SELLO, no la cotización: si dolarapi queda caído,
        //     la misma cotización se re-sella cada hora y su antigüedad REAL no
        //     tiene techo. Por eso el log de abajo es obligatorio.
        if (cached) {
            // EL ÚNICO SÍNTOMA OBSERVABLE. Sin este log, dolarapi cambiando un
            // campo congela el precio de MercadoPago en silencio y cobramos de
            // menos por cada Premium, sin que nada lo denuncie: el refresco del
            // sello borró la única señal que quedaba (el axios repetido).
            // `obtenidoAt: 0` marca el respaldo del .env, que NUNCA se obtuvo de
            // ningún lado. Sin el ternario, el log decía "OBTENIDA hace 30 años".
            errorLogger.error(
                cached.obtenidoAt
                    ? `[dollarRate] dolarapi no responde; se sirve una cotización OBTENIDA hace ` +
                      `${Math.round((now - cached.obtenidoAt) / 60000)} min (${cached.rate}). ` +
                      `Motivo: ${(error as Error)?.message}`
                    : `[dollarRate] dolarapi no responde y se sirve el RESPALDO del .env ` +
                      `(${cached.rate}): NO hubo ninguna cotización real desde que arrancó el ` +
                      `proceso. Motivo: ${(error as Error)?.message}`
            );
            cached = {
                rate: cached.rate,
                at: now,
                obtenidoAt: cached.obtenidoAt,
            };
            return cached.rate;
        }
        const fallback = Number(config.mercadopago.fallback_rate || 0);
        if (Number.isFinite(fallback) && fallback > 0) {
            // SE CACHEA EL FALLBACK. Antes se devolvía sin tocar `cached`, así que
            // mientras dolarapi estuviera caído CADA request pagaba un axios con
            // timeout de 5 s. Y el endpoint de precios es PÚBLICO: un pico de
            // tráfico durante esa caída mantenía N sockets salientes y N handlers
            // abiertos cinco segundos cada uno. Cacheándolo, la caída cuesta UNA
            // llamada por hora.
            //
            // `obtenidoAt: 0`, NO `now`: este número no se obtuvo de ningún lado,
            // es una constante escrita a mano en el .env. Ponerle `now` hacía que
            // el log de arriba lo reportara como "cotización OBTENIDA hace 0 min",
            // que es exactamente lo contrario de la verdad, en el área que tiene
            // vara de "seguro".
            cached = { rate: fallback, at: now, obtenidoAt: 0 };
            errorLogger.error(
                `[dollarRate] SE ESTÁ COBRANDO CON EL RESPALDO DEL .ENV (${fallback}), ` +
                    'no con una cotización real. Revisar MP_FALLBACK_RATE y dolarapi.'
            );
            return fallback;
        }
        // Sin este log, la caída es MUDA: `getSubscriptionPrices` se come este
        // error con un catch pelado y saca MercadoPago de la pantalla de precios
        // sin dejar una sola línea en ningún lado. El usuario ve un botón menos y
        // nadie sabe por qué.
        errorLogger.error(
            '[dollarRate] sin cotización y sin respaldo: MercadoPago va a desaparecer ' +
                `de la pantalla de precios. Motivo: ${(error as Error)?.message}`
        );
        throw new AppError(
            httpStatus.SERVICE_UNAVAILABLE,
            'No se pudo obtener la cotización del dólar para MercadoPago'
        );
    }
};

// Convierte un monto en dólares a pesos (redondeado) con la cotización del día.
export const usdToPesos = async (usd: number): Promise<number> => {
    const rate = await getDollarRate();
    return Math.round(usd * rate);
};
