import { NextFunction, Request, Response } from 'express';

// Elimina claves con operadores Mongo ($) o rutas con punto (.) para
// prevenir NoSQL injection y mass-assignment vía query/body/params.
const isForbiddenKey = (key: string): boolean =>
    key.startsWith('$') || key.includes('.');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sanitize = (obj: any): void => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
        if (isForbiddenKey(key)) {
            delete obj[key];
            continue;
        }
        const value = obj[key];
        if (value && typeof value === 'object') sanitize(value);
    }
};

const sanitizeMongo = (req: Request, _res: Response, next: NextFunction) => {
    sanitize(req.body);
    sanitize(req.query);
    sanitize(req.params);
    next();
};

export default sanitizeMongo;
