/* Socket.IO handshake token.
 * The browser cannot read the HttpOnly access-token cookie, so /auth/socket-token
 * mints this 30-minute JWT for the handshake only. `middlewares/auth.ts` rejects
 * the `scope:'socket'` claim, so it cannot open the HTTP API.
 *
 * `socket.ts` only reads `decode.id`, which is User._id (not profileId).
 * Pure module (no jsonwebtoken/config) → testable in runTests.ts.
 */

export const SOCKET_TOKEN_SCOPE = 'socket';

/** TTL in seconds; returned to clients so they refresh in time. */
export const SOCKET_TOKEN_TTL_SECONDS = 30 * 60;

/** jwt `exp` value; must match TTL_SECONDS. */
export const SOCKET_TOKEN_EXPIRES_IN = '30m';

export type SocketTokenClaims = {
    id: string;
    profileId: string;
    email: string;
    role: string;
    scope: typeof SOCKET_TOKEN_SCOPE;
};

type SessionUser = {
    id?: unknown;
    profileId?: unknown;
    email?: unknown;
    role?: unknown;
    scope?: unknown;
    // Index signature: `req.user` is a JwtPayload with arbitrary claims.
    [key: string]: unknown;
} | null | undefined;

/**
 * Socket token claims, or `null` if the session cannot be minted.
 * `id` is User._id; profileId/role come fresh from `req.user` (DB-backed).
 */
export const buildSocketTokenClaims = (
    user: SessionUser
): SocketTokenClaims | null => {
    const id = String(user?.id ?? '');
    const profileId = String(user?.profileId ?? '');
    if (!id || !profileId) return null;

    return {
        id,
        profileId,
        email: String(user?.email ?? ''),
        role: String(user?.role ?? ''),
        scope: SOCKET_TOKEN_SCOPE,
    };
};
