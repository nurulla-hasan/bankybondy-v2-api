import { NextFunction, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import config from '../config';

/**
 * Auth OPCIONAL para rutas públicas que se comportan distinto si hay alguien
 * logueado mirando.
 *
 * Motivo: hay endpoints públicos (ej. el listado de feedback de un audio) que YA
 * traen la lógica de "ocultar el contenido de usuarios bloqueados", pero
 * condicionada a un `viewerId` que nunca llegaba: al no tener middleware de auth,
 * `req.user` quedaba vacío y el filtro no corría NUNCA. Resultado: alguien a
 * quien bloqueaste te seguía apareciendo en los comentarios.
 *
 * Diferencia clave con `auth`: este middleware **NUNCA rechaza**. Si no hay
 * token, si está vencido, si es inválido o si el secreto no está configurado,
 * sigue de largo como visitante anónimo. La ruta tiene que seguir funcionando
 * sin sesión — por eso todo va dentro de un try/catch y siempre se llama a
 * `next()`.
 *
 * NO usar para proteger nada: no valida que el usuario exista, ni que no esté
 * borrado/bloqueado/sin verificar (eso lo hace `auth`). Sólo sirve para saber
 * QUIÉN está mirando, cuando saberlo mejora la respuesta.
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
            // Token ausente/vencido/inválido: se sigue como anónimo, sin error.
        }
        next();
    };
};

export default optionalAuth;
