/* Idempotent migration: the FREE plan limit went from 10 to 25. Users created with
 * the old default get raised to 25; Standard (100) and Premium (1000) are excluded
 * by the `bondLimit < 25` filter. Fire-and-forget at boot; running it N times is a
 * no-op. */
import NormalUser from './normalUser.model';
import { logger } from '../../shared/logger';

const FREE_BOND_LIMIT = 25;

export const bumpFreeBondLimit = async (): Promise<void> => {
    const res = await NormalUser.updateMany(
        { bondLimit: { $lt: FREE_BOND_LIMIT } },
        { $set: { bondLimit: FREE_BOND_LIMIT } }
    );
    const modified = (res as { modifiedCount?: number })?.modifiedCount ?? 0;
    if (modified) {
        logger.info(
            `[migración] bumpFreeBondLimit: ${modified} usuario(s) free subidos a ${FREE_BOND_LIMIT} vínculos.`
        );
    }
};

export default bumpFreeBondLimit;
