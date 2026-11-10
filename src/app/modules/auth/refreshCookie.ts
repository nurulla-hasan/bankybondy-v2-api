import { Response } from 'express';
import config from '../../config';

// HttpOnly auth cookie names: the browser never exposes them to JS (mitigates
// session theft via XSS).
export const ACCESS_COOKIE_NAME = 'accessToken';
export const REFRESH_COOKIE_NAME = 'refreshToken';

// 1 year for the refresh cookie; the JWT enforces the real expiry.
const REFRESH_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365;

// 30 days for the access cookie; the JWT expiry is authoritative.
const ACCESS_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;

const isProd = config.NODE_ENV === 'production';

export const setAccessCookie = (res: Response, token: string): void => {
    res.cookie(ACCESS_COOKIE_NAME, token, {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        path: '/',
        maxAge: ACCESS_COOKIE_MAX_AGE_MS,
    });
};

export const setRefreshCookie = (res: Response, token: string): void => {
    res.cookie(REFRESH_COOKIE_NAME, token, {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        path: '/',
        maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    });
};

export const setAuthCookies = (
    res: Response,
    tokens: { accessToken?: string; refreshToken?: string }
): void => {
    if (tokens.accessToken) {
        setAccessCookie(res, tokens.accessToken);
    }
    if (tokens.refreshToken) {
        setRefreshCookie(res, tokens.refreshToken);
    }
};

export const clearAccessCookie = (res: Response): void => {
    res.clearCookie(ACCESS_COOKIE_NAME, {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        path: '/',
    });
};

export const clearRefreshCookie = (res: Response): void => {
    res.clearCookie(REFRESH_COOKIE_NAME, {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        path: '/',
    });
};

export const clearAuthCookies = (res: Response): void => {
    clearAccessCookie(res);
    clearRefreshCookie(res);
};

