/* Daily USD rate for MercadoPago ARS pricing, cached 1 hour. On API failure it
 * serves the last known rate, then MP_FALLBACK_RATE, then throws. */
import axios from 'axios';
import httpStatus from 'http-status';
import config from '../config';
import AppError from '../error/appError';
import { errorLogger } from '../shared/logger';

// Two timestamps: `at` is the cache stamp (re-stamped when serving a stale rate to
// avoid paying the 5s axios on every request); `obtenidoAt` is when the rate was
// really fetched and must never be re-stamped, so the log keeps measuring real age.
let cached: { rate: number; at: number; obtenidoAt: number } | null = null;
const TTL_MS = 60 * 60 * 1000; // 1 hour

// Pesos per USD (sell price) for the configured dollar type (blue by default).
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
        // Fallback: last known rate, then .env reserve.
        //
        // `at` is re-stamped because otherwise every request pays the 5s axios while
        // dolarapi is down. There is no single-flight, so the "one call per hour" only
        // holds per burst; and what gets re-stamped is the stamp, not the rate, so its
        // real age is unbounded — hence the log below is mandatory.
        if (cached) {
            // The only observable symptom: without it a silent dolarapi field change
            // freezes the price. `obtenidoAt: 0` marks the .env fallback, never fetched.
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
            // Cache the fallback too: the prices endpoint is public, so an uncached
            // fallback kept N sockets/handlers open for 5s each during an outage.
            //
            // `obtenidoAt: 0`, not `now`: this value was never fetched, and `now`
            // would make the log report it as a rate obtained "0 min ago".
            cached = { rate: fallback, at: now, obtenidoAt: 0 };
            errorLogger.error(
                `[dollarRate] SE ESTÁ COBRANDO CON EL RESPALDO DEL .ENV (${fallback}), ` +
                    'no con una cotización real. Revisar MP_FALLBACK_RATE y dolarapi.'
            );
            return fallback;
        }
        // Without this log the outage is silent: getSubscriptionPrices swallows the
        // error and MercadoPago just disappears from the pricing screen.
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

// Convert USD to rounded pesos using today's rate.
export const usdToPesos = async (usd: number): Promise<number> => {
    const rate = await getDollarRate();
    return Math.round(usd * rate);
};
