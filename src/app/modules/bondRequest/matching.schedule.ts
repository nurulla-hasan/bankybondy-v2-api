/* Recompute agenda: WHEN a bond is recomputed (hot/warm/cold TTLs, not one uniform TTL).
 * Temperature uses the newest of createdAt/lastServedAt — `updatedAt` is rewritten by our own bookkeeping. */

/** The three attention tiers. */
export type TemperaturaVinculo = 'caliente' | 'tibio' | 'frio';

/** Expired-agenda sentinel (the Unix epoch), used instead of a missing field so the
 *  sweep filter is a plain `$lte` range the index also sorts. An `$exists:false` `$or`
 *  forces a blocking SORT (32 MB cap) over ~40 KB vector docs, which silently returns 0. */
// `Object.freeze` doesn't block `setTime`, so real immutability means returning a NEW
// instance: one `.setTime()` on a shared Date would shift the agenda system-wide.
const EPOCA_MS = 0;
export const agendaVencida = (): Date => new Date(EPOCA_MS);

const MINUTO_MS = 60 * 1000;
const HORA_MS = 60 * MINUTO_MS;

/** Reads a numeric env with default and clamp; an empty string counts as absent. */
const num = (
    v: string | undefined,
    def: number,
    opts: { min: number; max: number }
): number => {
    const raw = typeof v === 'string' ? v.trim() : v;
    const n = raw === '' || raw === undefined ? NaN : Number(raw);
    let out = Number.isFinite(n) ? n : def;
    if (out < opts.min) out = opts.min;
    if (out > opts.max) out = opts.max;
    return out;
};

/** Agenda dials, all overridable by env. The minimums matter: a 0 TTL would put the
 *  sweep back into continuous recompute (the runaway compute the API once hit). */
const ventanaCalienteHoras = num(process.env.MATCH_HOT_WINDOW_HOURS, 72, {
    min: 1,
    max: 24 * 30,
});

export const AGENDA = {
    // "hot" window: created or last served within these hours.
    ventanaCalienteHoras,
    // "warm" window (14 days). The `Math.max` keeps warm >= hot: a smaller warm
    // window would make 'tibio' unreachable with no visible error.
    ventanaTibiaHoras: Math.max(
        ventanaCalienteHoras,
        num(process.env.MATCH_WARM_WINDOW_HOURS, 24 * 14, {
            min: 1,
            max: 24 * 365,
        })
    ),
    // TTL per tier, in minutes.
    ttlCalienteMin: num(process.env.MATCH_TTL_HOT_MINUTES, 60, {
        min: 5,
        max: 24 * 60,
    }),
    ttlTibioMin: num(process.env.MATCH_TTL_WARM_MINUTES, 360, {
        min: 5,
        max: 24 * 60,
    }),
    ttlFrioMin: num(process.env.MATCH_TTL_COLD_MINUTES, 1440, {
        min: 5,
        max: 24 * 7 * 60,
    }),
};

/** Minimum input for the temperature decision. Everything is optional except `ahora`,
 *  so a legacy bond with an unreadable `createdAt` doesn't break the sweep. */
export type EntradaTemperatura = {
    ahora: number;
    createdAt?: Date | string | number | null;
    lastServedAt?: Date | string | number | null;
};

/** Milliseconds, or null if not a usable date. `getTime()` on an Invalid Date is NaN,
 *  and a leaked NaN would make every comparison false, silently yielding 'frio'. */
const aMs = (v: Date | string | number | null | undefined): number | null => {
    if (v === null || v === undefined) return null;
    const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
};

/** Bond temperature: the newest of creation and last served. No usable signal →
 *  'frio' (the sweep still picks it up, just less often). */
export const temperaturaDe = (
    e: EntradaTemperatura,
    dials = AGENDA
): TemperaturaVinculo => {
    const creado = aMs(e.createdAt);
    const servido = aMs(e.lastServedAt);

    // No signal: cold. "Never computed" is handled by the missing `matchesNextAt`
    // in the sweep, not here; this only sets the refresh cadence from now on.
    if (creado === null && servido === null) return 'frio';

    const masReciente = Math.max(creado ?? -Infinity, servido ?? -Infinity);
    const antiguedadHoras = (e.ahora - masReciente) / HORA_MS;

    // A future signal (skewed clock, seeded data) gives negative age: treated as hot,
    // the safe side (refresh more, not less).
    if (antiguedadHoras <= dials.ventanaCalienteHoras) return 'caliente';
    if (antiguedadHoras <= dials.ventanaTibiaHoras) return 'tibio';
    return 'frio';
};

/** TTL minutes for a temperature. */
export const ttlMinutosDe = (
    t: TemperaturaVinculo,
    dials = AGENDA
): number => {
    if (t === 'caliente') return dials.ttlCalienteMin;
    if (t === 'tibio') return dials.ttlTibioMin;
    return dials.ttlFrioMin;
};

/** When this bond is due for its next recompute.
 *
 *  We store the AGENDA (a future instant), not history, so the sweep is a single
 *  `matchesNextAt <= ahora` query served by one index. The policy lives here, on the
 *  write side, where everything about the bond is already known. */
export const proximoRecomputoEn = (
    e: EntradaTemperatura,
    dials = AGENDA
): Date => {
    const ttlMin = ttlMinutosDe(temperaturaDe(e, dials), dials);
    return new Date(e.ahora + ttlMin * MINUTO_MS);
};

export default AGENDA;
