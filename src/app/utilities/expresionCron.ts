import cron from 'node-cron';
import { errorLogger } from '../shared/logger';

/** La expresión de cron de una variable de entorno, SIEMPRE válida.
 *
 *  Con una expresión mal escrita, `cron.schedule` lanza SINCRÓNICO (node-cron
 *  3.0.3, medido el 29/9). Los barridos arrancan dentro del `main()` del worker,
 *  cuyo catch hace `process.exit(1)`: el matcher entraba en un bucle de reinicios
 *  y la cola dejaba de consumirse. Tampoco sirve un try/catch que siga de largo:
 *  deja el barrido APAGADO y el proceso "sano" por fuera, que es la clase de
 *  falla que tuvo tres vínculos 61 días sin recomputarse.
 *
 *  Acá: si la del .env no valida, queda el error en el log y se usa la de por
 *  defecto. Vacía o ausente = la de por defecto, igual que el `||` de antes. */
export const expresionCron = (variable: string, porDefecto: string): string => {
    const valor = process.env[variable];
    if (!valor) return porDefecto;
    if (cron.validate(valor)) return valor;
    errorLogger.error(
        `[cron] ${variable}="${valor}" no es una expresión válida: se usa "${porDefecto}".`
    );
    return porDefecto;
};
