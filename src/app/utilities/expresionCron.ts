import cron from 'node-cron';
import { errorLogger } from '../shared/logger';

/** Cron expression from an env var, ALWAYS valid.
 *
 *  A malformed expression makes `cron.schedule` throw synchronously (node-cron
 *  3.0.3); sweeps start inside the worker's `main()`, whose catch exits the
 *  process, so the matcher entered a restart loop. Swallowing the error is worse:
 *  it leaves the sweep OFF while the process looks healthy.
 *  Here an invalid env value is logged and the default is used; empty/missing
 *  also falls back to the default. */
export const expresionCron = (variable: string, porDefecto: string): string => {
    const valor = process.env[variable];
    if (!valor) return porDefecto;
    if (cron.validate(valor)) return valor;
    errorLogger.error(
        `[cron] ${variable}="${valor}" no es una expresión válida: se usa "${porDefecto}".`
    );
    return porDefecto;
};
