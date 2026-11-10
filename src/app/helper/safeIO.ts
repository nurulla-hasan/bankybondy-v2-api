import type { Server as IOServer } from 'socket.io';
import { getIO } from '../socket/socket';

/** `getIO()` without the throw. `getIO()` throws when the socket layer is not up
 *  in THIS process (e.g. the matcher worker), and a REST endpoint must not 500
 *  for that: the DB write already happened. `null` = no realtime, never an error. */
export const getSafeIO = (): IOServer | null => {
    try {
        return getIO();
    } catch {
        return null;
    }
};
