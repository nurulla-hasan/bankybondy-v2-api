/* Migración idempotente: el límite del plan GRATIS pasó de 10 (viejo) a 25.
 * Los usuarios free creados con el default viejo quedaron con bondLimit < 25.
 * Esto los sube a 25. NO toca Standard (100) ni Premium (1000): esos ya tienen
 * bondLimit >= 25, así que el filtro `bondLimit < 25` los excluye por construcción.
 * Fire-and-forget desde el arranque; correrla N veces no cambia nada (idempotente). */
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
