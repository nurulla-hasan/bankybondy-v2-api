import type { Server as IOServer } from 'socket.io';
import { getIO } from '../socket/socket';

/**
 * `getIO()` sin el throw.
 *
 * `getIO()` LANZA cuando la capa de sockets no está levantada en ESTE proceso
 * (el worker de matcheo no la levanta, y `sendNotification` ya lo sorteaba a
 * mano con un try/catch). Un endpoint REST no puede devolver 500 por eso: el
 * write en la base ya ocurrió y el aviso en tiempo real es secundario.
 *
 * `null` significa "sin realtime", nunca "error".
 */
export const getSafeIO = (): IOServer | null => {
    try {
        return getIO();
    } catch {
        return null;
    }
};
