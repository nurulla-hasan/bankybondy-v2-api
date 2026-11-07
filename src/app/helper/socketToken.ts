/* Token de handshake para Socket.IO (B0).
 *
 * POR QUÉ EXISTE: el browser ya no puede leer el access token (vive en una cookie
 * HttpOnly), y `socket.ts` exige un JWT firmado en `handshake.auth.token`. Sin
 * esto, un front que use cookies (bankybondy-v2) simplemente no puede abrir un
 * socket. El endpoint `/auth/socket-token` toma la cookie y mintea ESTE token.
 *
 * POR QUÉ ES ACEPTABLE SACAR UN JWT AL JS: es de 30 minutos, y a diferencia del
 * access token no sirve para la API HTTP — `middlewares/auth.ts` rechaza
 * explícitamente la claim `scope:'socket'`. Queda útil para una sola cosa: el
 * handshake del chat. Y el socket sigue haciendo las mismas comprobaciones de
 * siempre (firma + estado del usuario en la DB: borrado, bloqueado, sin
 * verificar, contraseña cambiada), así que revocar una cuenta corta el socket en
 * la próxima conexión, no dentro de 30 días.
 *
 * `socket.ts` NO se toca: sólo lee `decode.id`, y acá va el mismo `id` (el `_id`
 * de User, no el profileId) que firman los seis puntos habituales.
 *
 * Función PURA (sin jsonwebtoken ni config) → testeable en runTests.ts.
 */

export const SOCKET_TOKEN_SCOPE = 'socket';

/** TTL en segundos; va en la respuesta para que el cliente refresque antes. */
export const SOCKET_TOKEN_TTL_SECONDS = 30 * 60;

/** Lo que entiende `jsonwebtoken` para el `exp`. Debe seguir a TTL_SECONDS. */
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
    // Index signature: `req.user` es un `JwtPayload` (cualquier claim puede
    // venir adentro), y sin esta línea TS no lo deja pasar.
    [key: string]: unknown;
} | null | undefined;

/**
 * Claims del token de socket, o `null` si la sesión no es minteable.
 *
 * El `id` es el `_id` de User (el socket lo usa para `User.findById`), y el
 * `profileId`/`role` van frescos desde `req.user` — que el middleware ya rellena
 * con la DB, no con el token viejo. Nunca se inventa un rol: si el token de
 * sesión trajera un `role` distinto al de la DB, acá va el de `req.user`, y el
 * socket de todos modos vuelve a leer la DB al conectar.
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
