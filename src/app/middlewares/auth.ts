/* eslint-disable no-unused-vars */
import { NextFunction, Request, Response } from 'express';
import catchAsync from '../utilities/catchasync';
import AppError from '../error/appError';
import httpStatus from 'http-status';
import jwt, { JwtPayload } from 'jsonwebtoken';
import config from '../config';
import { TUserRole } from '../modules/user/user.interface';
import { SOCKET_TOKEN_SCOPE } from '../helper/socketToken';
import { User } from '../modules/user/user.model';
import { esObjectIdUsable } from '../utilities/objectId';

const auth = (...requiredRoles: TUserRole[]) => {
    return catchAsync(
        async (req: Request, res: Response, next: NextFunction) => {
            // Token may come from the cookie or the Authorization header.
            let token = req?.cookies?.accessToken || req?.headers?.authorization;
            if (!token) {
                throw new AppError(
                    httpStatus.UNAUTHORIZED,
                    'Your are not authorized 1'
                );
            }
            if (token.startsWith('Bearer ')) {
                token = token.slice(7);
            }
            let decoded;

            try {
                decoded = jwt.verify(
                    token,
                    config.jwt_access_secret as string
                ) as JwtPayload;
            } catch (err) {
                throw new AppError(httpStatus.UNAUTHORIZED, 'Token is expired');
            }
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { id, role, email, profileId, iat } = decoded;

            if (!decoded) {
                throw new AppError(httpStatus.UNAUTHORIZED, 'Token is expired');
            }

            // Socket handshake tokens share jwt_access_secret (socket.ts accepts
            // them), so they must be rejected here explicitly.
            if (decoded.scope === SOCKET_TOKEN_SCOPE) {
                throw new AppError(
                    httpStatus.UNAUTHORIZED,
                    'Invalid session token',
                    'INVALID_TOKEN'
                );
            }

            // PRIVILEGE ESCALATION: `User.findById(undefined)` drops the key and
            // returns the first user (usually the seeded superAdmin). A token
            // without a usable `id` must fail closed.
            if (!esObjectIdUsable(id)) {
                throw new AppError(
                    httpStatus.UNAUTHORIZED,
                    'Invalid session token',
                    'INVALID_TOKEN'
                );
            }

            const user = await User.findById(id);
            if (!user) {
                throw new AppError(
                    httpStatus.NOT_FOUND,
                    'This user does not exist',
                    // Code included because a hard-deleted account is also a dead
                    // session; clients only intercept 401 and would never log out.
                    'ACCOUNT_NOT_FOUND'
                );
            }
            if (user.isDeleted) {
                throw new AppError(
                    httpStatus.FORBIDDEN,
                    'This user is already deleted',
                    // These 403s carry a code because the frontend cannot fix them
                    // with a refresh: the session is dead and must log out.
                    'ACCOUNT_DELETED'
                );
            }
            if (user.isBlocked) {
                throw new AppError(
                    httpStatus.FORBIDDEN,
                    'This user is blocked',
                    'ACCOUNT_BLOCKED'
                );
            }
            if (!user?.isVerified) {
                throw new AppError(
                    httpStatus.BAD_REQUEST,
                    'You are not verified user'
                );
            }

            if (user?.passwordChangedAt && iat) {
                const passwordChangeTime =
                    new Date(user?.passwordChangedAt).getTime() / 1000;
                if (passwordChangeTime > iat) {
                    throw new AppError(
                        httpStatus.FORBIDDEN,
                        'You are not authorized 2',
                        // Password changed after this token was issued → log out.
                        'PASSWORD_CHANGED'
                    );
                }
            }
            // Fresh DB role, so a revoked role loses access immediately.
            // `requiredRoles` is always an array; check its length because
            // `auth()` with no roles must allow any logged-in user.
            if (
                requiredRoles.length &&
                !requiredRoles.includes(user.role)
            ) {
                throw new AppError(
                    httpStatus.UNAUTHORIZED,
                    'Your are not authorized 3'
                );
            }
            // `profileId` also comes fresh from the DB, not from the token.
            const profileIdFresco = user.profileId;

            // Reject an unusable profileId: mongoose drops `undefined` keys, which
            // turns `findOne({ user: undefined, _id })` into `findOne({ _id })`
            // and drops the ownership predicate (~20 queries use that shape).
            if (!esObjectIdUsable(profileIdFresco)) {
                throw new AppError(
                    httpStatus.UNAUTHORIZED,
                    'Your session is missing its profile. Please log in again.',
                    'PROFILE_MISSING'
                );
            }

            // Fresh DB role, so controllers don't read a stale token role.
            req.user = {
                ...decoded,
                role: user.role,
                profileId: profileIdFresco,
            } as JwtPayload;
            next();
        }
    );
};

export default auth;
