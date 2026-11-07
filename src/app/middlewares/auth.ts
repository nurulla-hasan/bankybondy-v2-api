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

// make costume interface

const auth = (...requiredRoles: TUserRole[]) => {
    return catchAsync(
        async (req: Request, res: Response, next: NextFunction) => {
            // check if the token is sent from cookie or authorization header -----
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

            // Un token de handshake de socket NO puede abrir la API HTTP. Se firma
            // con el MISMO `jwt_access_secret` (así `socket.ts` lo acepta sin
            // tocarlo), y sin este guard un `/auth/socket-token` robado-valiente
            // sería un access token normal durante 30 minutos. Ningún token emitido
            // hoy por esta API lleva la claim `scope` (verificado en los 6 puntos
            // que firman), así que esto no rechaza nada que funcione ahora.
            if (decoded.scope === SOCKET_TOKEN_SCOPE) {
                throw new AppError(
                    httpStatus.UNAUTHORIZED,
                    'Invalid session token',
                    'INVALID_TOKEN'
                );
            }

            // ESCALADA DE PRIVILEGIO (la razón principal de este bloque):
            // `User.findById(undefined)` NO falla. Mongoose descarta la clave
            // `undefined` y el filtro queda en `{}` —verificado contra el mongoose
            // 8.24.1 del repo—, así que devuelve el PRIMER usuario de la colección,
            // que típicamente es el superAdmin sembrado por DB/index. Y como más
            // abajo `req.user` toma el rol de ESE documento, un token sin `id` se
            // convertía en superAdmin. (`findById(null)` sí falla cerrado: produce
            // `{_id: null}`. El agujero es exclusivamente el valor AUSENTE.)
            // Cero superficie de lockout: los 6 puntos que firman tokens mandan
            // siempre `id: user._id`.
            if (!esObjectIdUsable(id)) {
                throw new AppError(
                    httpStatus.UNAUTHORIZED,
                    'Invalid session token',
                    'INVALID_TOKEN'
                );
            }

            // get the user if that here ---------
            const user = await User.findById(id);
            if (!user) {
                throw new AppError(
                    httpStatus.NOT_FOUND,
                    'This user does not exist',
                    // Con código porque TAMBIÉN es una sesión muerta, y el borrado
                    // de cuenta es un HARD delete (`user.services` hace
                    // `findByIdAndDelete`, no un `isDeleted`). Escenario real: te
                    // borrás la cuenta desde el celular y la pestaña abierta en la
                    // laptop tiene un access token de hasta 30 días → todas las
                    // pantallas devuelven 404, el front no mira 404 y nunca
                    // desloguea. `ACCOUNT_DELETED` cubre el borrado LÓGICO y dejaba
                    // afuera justo el real.
                    'ACCOUNT_NOT_FOUND'
                );
            }
            if (user.isDeleted) {
                throw new AppError(
                    httpStatus.FORBIDDEN,
                    'This user is already deleted',
                    // Los tres 403 de acá llevan `code` porque el front NO puede
                    // arreglarlos con un refresh: la sesión está muerta y hay que
                    // deslogear. Sin el código, el front (que sólo intercepta 401)
                    // los ignoraba y el usuario quedaba "logueado" con todas las
                    // pantallas rotas, sin mensaje y sin salida. Le pasa HOY a
                    // cualquiera a quien un admin bloquee.
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
                        // La contraseña cambió después de emitir este token: es
                        // exactamente el caso donde hay que deslogear (puede ser
                        // el dueño legítimo echando a un intruso desde otro
                        // dispositivo).
                        'PASSWORD_CHANGED'
                    );
                }
            }
            // Usamos el rol FRESCO de la DB (user.role), no el del token ya emitido:
            // si a alguien se le revoca/baja el rol, no queda con permisos hasta que
            // expire el token. El `user` ya se leyó arriba, así que es gratis.
            // `requiredRoles` es un rest param: SIEMPRE es un array, así que
            // siempre es truthy. Con `auth()` sin roles (que se lee como
            // "cualquier usuario logueado") quedaba [] y `[].includes(x)` es
            // false -> denegaba a todo el mundo. Se chequea el largo.
            if (
                requiredRoles.length &&
                !requiredRoles.includes(user.role)
            ) {
                throw new AppError(
                    httpStatus.UNAUTHORIZED,
                    'Your are not authorized 3'
                );
            }
            // El `profileId` también sale FRESCO de la DB, no del token. El
            // documento ya está cargado arriba, así que es gratis, y con esto un
            // access token viejo (hasta 30 días) que no traiga la claim deja de
            // importar: se rellena con el valor real. Mismo criterio que ya se
            // aplicaba al `role`.
            const profileIdFresco = user.profileId;

            // Si NI SIQUIERA el valor de la DB sirve, se corta acá. El motivo es el
            // mismo que arriba: mongoose descarta las claves `undefined`, así que un
            // `findOne({ user: undefined, _id })` se convierte en `findOne({ _id })`
            // y el predicado de PROPIEDAD desaparece → se lee, se edita o se borra
            // lo ajeno. Hay ~20 consultas con esa forma en la API.
            // Se valida el valor FRESCO (no el del token) y con `isValid`, no con
            // `!`: el string vacío pasaría el `!` y después tira CastError → 500.
            // MEDIDO el 17/8 contra la base real: 0 cuentas afectadas sobre 46, y 0
            // perfiles huérfanos. O sea que hoy esto es 100% PREVENTIVO y no deja a
            // nadie afuera. Se aplica a todos los roles porque las rutas mixtas
            // (playlist acepta user/admin/superAdmin) si no quedan con huecos.
            if (!esObjectIdUsable(profileIdFresco)) {
                throw new AppError(
                    httpStatus.UNAUTHORIZED,
                    'Your session is missing its profile. Please log in again.',
                    'PROFILE_MISSING'
                );
            }

            // add those properties in req
            // El rol va FRESCO de la DB, no el del token: si no, el chequeo de
            // arriba usaba el rol nuevo pero los controllers leían el viejo de
            // `req.user.role` y la revocación no tenía efecto para ellos.
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
