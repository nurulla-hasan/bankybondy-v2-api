/* eslint-disable @typescript-eslint/no-explicit-any */
import path from 'path';
import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
const { combine, timestamp, label, printf, errors } = format;

// Custom log
//
// EL STACK SE IMPRIME (arreglado 10/9). Antes este `printf` sólo usaba
// {level, message, label, timestamp} y DESCARTABA el stack trace: un
// `errorLogger.error('Unhandled Rejection:', err)` dejaba en el log la etiqueta
// y nada más — ni el mensaje del error, ni dónde ocurrió.
//
// Es la PRECONDICIÓN del cambio de postura de `server.ts`: pasar de "morir ante
// una promesa rechazada" a "loguear y seguir" SIN esto habría cambiado un crash
// ruidoso por un log ciego, que es peor que lo que había.
//
// Se cubren las dos formas en que llega un Error:
//  - como MENSAJE (`logger.error(err)`)      -> lo expone `format.errors` en `stack`.
//  - como META    (`logger.error('x:', err)`) -> llega en el SPLAT de winston.
const SPLAT = Symbol.for('splat');

// NUNCA puede tirar. Si tirara, la excepción saldría SÍNCRONA de `logger.error()`
// — y como `server.ts` llama al logger DENTRO del handler de `unhandledRejection`,
// Node la convertiría en `uncaughtException` y mataría el proceso. O sea: el
// arreglo anti-caída sería la causa de la caída. Por eso hay un tercer nivel:
// `String(v)` TAMBIÉN puede tirar (objeto con `toString` que lanza, proxy con
// getter hostil), así que va adentro de su propio try.
const serializar = (v: any): string => {
    try {
        if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
        if (typeof v === 'string') return v;
        try {
            return JSON.stringify(v);
        } catch {
            return String(v); // referencias circulares, BigInt, etc.
        }
    } catch {
        return '[valor no serializable]';
    }
};

const myFormat = printf((info: any) => {
  try {
    const { level, message, label, timestamp, stack } = info;
    const date = new Date(timestamp);
    const h = date.getHours();
    const m = date.getMinutes();
    const s = date.getSeconds();

    let salida = `${date.toDateString()} ${h}:${m} ${s} [${label}] ${level}: ${message}`;

    // Se saltea SOLO el Error que ya está promovido en `info.stack`, comparando
    // el stack — no "todos los Error si hay stack".
    //
    // CORRECCIÓN (10/9, panel adversarial). La versión anterior filtraba
    // `!(stack && v instanceof Error)` y eso se tragaba el SEGUNDO error entero:
    // `log.error('dos:', e1, e2)` imprimía sólo e1 y e2 desaparecía, ni mensaje
    // ni stack. Probado corriendo.
    //
    // Y el comentario que la justificaba era FALSO: decía que `format.errors`
    // promueve el Error del meta. NO lo hace — `logform/errors.js` sólo mira
    // `einfo instanceof Error` y `einfo.message instanceof Error`, nunca toca el
    // SPLAT. Quien setea `info.stack` en el caso meta es winston mismo, antes de
    // que corra ningún format. `errors({stack:true})` sí hace falta, pero sólo
    // para `logger.error(err)` a secas. Esa razón equivocada fue la que produjo
    // el bug de arriba.
    const extras = (info[SPLAT] || [])
        .filter((v: any) => !(stack && v instanceof Error && v.stack === stack))
        .map(serializar)
        .filter(Boolean);
    if (extras.length) salida += ' ' + extras.join(' ');
    // `stack` ya incluye "Name: message" en su primera línea.
    if (stack) salida += `\n${stack}`;

    return salida;
  } catch {
    // EL FORMATO NUNCA PUEDE TIRAR (10/9, 2ª ronda de panel).
    // `serializar` quedó blindada en la ronda anterior, pero la superficie se
    // había movido HACIA ARRIBA y seguía viva: la interpolación `${message}`
    // tira si `message` es un Symbol o un objeto cuyo `toString` lanza. Y como
    // `server.ts` llama al logger DENTRO del handler de `unhandledRejection`,
    // eso terminaba en `uncaughtException` -> exit(1): el arreglo anti-caída
    // como causa de la caída, que es justo lo que la ronda anterior declaró
    // cerrado y no lo estaba.
    return '[log no formateable]';
  }
});

const logDir = path.join(process.cwd(), 'logs', 'winston');

export const logger = createLogger({
  level: 'info',
  // `errors({ stack: true })` expone `info.stack` cuando el Error viaja como
  // MENSAJE. Sin esto, `myFormat` no tendría stack que imprimir en ese caso.
  format: combine(
    errors({ stack: true }),
    label({ label: 'Cigar App' }),
    timestamp(),
    myFormat
  ),
  transports: [
    new transports.Console(),
    new transports.File({
      level: 'info',
      filename: path.join(logDir, 'successes', 'um-success.log'),
    }),

    new DailyRotateFile({
      level: 'info',
      filename: path.join(logDir, 'successes', 'um-%DATE%-success.log'),
      datePattern: 'YYYY-MM-DD-HH',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
    }),
  ],
});

export const errorLogger = createLogger({
  level: 'error',
  // `errors({ stack: true })` expone `info.stack` cuando el Error viaja como
  // MENSAJE. Sin esto, `myFormat` no tendría stack que imprimir en ese caso.
  format: combine(
    errors({ stack: true }),
    label({ label: 'Cigar App' }),
    timestamp(),
    myFormat
  ),
  transports: [
    new transports.Console(),
    new DailyRotateFile({
      level: 'error',
      filename: path.join(logDir, 'errors', 'um-%DATE%-error.log'),
      datePattern: 'YYYY-MM-DD-HH',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
    }),
  ],
});
