import { NextFunction, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import config from '../config';

/**
 * Optional auth for public routes that behave differently for logged-in viewers
 * (e.g. hiding blocked users' content). Unlike `auth`, it NEVER rejects: it only
 * populates `req.user` when a valid token is present, so routes keep working
 * anonymously. Never use it to protect anything.
 */
const optionalAuth = () => {
    return (req: Request, _res: Response, next: NextFunction): void => {
        try {
            let token = req?.headers?.authorization;
            if (!token) return next();
            if (token.startsWith('Bearer ')) token = token.slice(7);

            const decoded = jwt.verify(
                token,
                config.jwt_access_secret as string
            ) as JwtPayload;

            if (decoded) req.user = decoded;
        } catch {
            // Missing/expired/invalid token: continue as anonymous, no error.
        }
        next();
    };
};

export default optionalAuth;
