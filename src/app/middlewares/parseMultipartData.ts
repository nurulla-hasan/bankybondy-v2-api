import { NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import AppError from '../error/appError';

const parseMultipartData = (
    req: Request,
    _res: Response,
    next: NextFunction
) => {
    const rawData = req.body?.data;
    if (rawData === undefined) return next();
    if (typeof rawData !== 'string') {
        return next(
            new AppError(httpStatus.BAD_REQUEST, 'Invalid multipart data')
        );
    }

    try {
        const parsed = JSON.parse(rawData);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return next(
                new AppError(httpStatus.BAD_REQUEST, 'Invalid multipart data')
            );
        }
        req.body = parsed;
        return next();
    } catch {
        return next(
            new AppError(httpStatus.BAD_REQUEST, 'Invalid multipart data JSON')
        );
    }
};

export default parseMultipartData;
