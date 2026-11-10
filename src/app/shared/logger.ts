/* eslint-disable @typescript-eslint/no-explicit-any */
import path from 'path';
import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
const { combine, timestamp, label, printf, errors } = format;

// Custom log.
//
// The STACK IS PRINTED. The old `printf` kept only {level, message, label, timestamp}
// and dropped the stack trace: `errorLogger.error('Unhandled Rejection:', err)` left the
// label and nothing else. Without this, logging-and-continuing in server.ts would mean
// a blind log instead of a loud crash. Both shapes are covered: Error as MESSAGE
// (`format.errors` exposes `info.stack`) and Error as META (arrives in winston's splat).
const SPLAT = Symbol.for('splat');

// This can NEVER throw. A throw here would escape `logger.error()` synchronously and, since
// server.ts logs inside the unhandledRejection handler, Node would turn it into an
// uncaughtException and kill the process: the anti-crash fix causing the crash. `String(v)`
// can throw too (hostile toString/proxy getters), hence the innermost try.
const serializar = (v: any): string => {
    try {
        if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
        if (typeof v === 'string') return v;
        try {
            return JSON.stringify(v);
        } catch {
            return String(v); // circular refs, BigInt, etc.
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

    // Skip ONLY the Error already promoted into `info.stack`, by comparing stacks.
    // Filtering every Error with a stack swallowed the second one entirely; and the old
    // comment was wrong: `format.errors` never promotes a meta Error — winston sets
    // `info.stack` itself before any format runs.
    const extras = (info[SPLAT] || [])
        .filter((v: any) => !(stack && v instanceof Error && v.stack === stack))
        .map(serializar)
        .filter(Boolean);
    if (extras.length) salida += ' ' + extras.join(' ');
    // `stack` already includes "Name: message" on its first line.
    if (stack) salida += `\n${stack}`;

    return salida;
  } catch {
    // THE FORMAT MUST NEVER THROW. `${message}` throws for a Symbol or an object whose
    // toString throws, and inside server.ts' rejection handler that becomes exit(1).
    return '[log no formateable]';
  }
});

const logDir = path.join(process.cwd(), 'logs', 'winston');

export const logger = createLogger({
  level: 'info',
  // `errors({ stack: true })` exposes `info.stack` when the Error travels as the
  // MESSAGE; without it `myFormat` would have no stack to print in that case.
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
  // `errors({ stack: true })` exposes `info.stack` when the Error travels as the
  // MESSAGE; without it `myFormat` would have no stack to print in that case.
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
