/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Migración idempotente para las notificaciones de match (corre una vez en el
 * boot de la API, fire-and-forget). Dos pasos, en ESTE orden:
 *
 * 1) COLAPSA las notificaciones MATCH duplicadas por (receiver, redirectId):
 *    conserva la MÁS NUEVA (mayor createdAt) y borra el resto. Es necesario
 *    porque el comportamiento anterior creaba una fila por cada pasada del robot,
 *    y quedaron varias "Nuevo match" del mismo vínculo en la campana.
 *
 * 2) Crea un ÍNDICE ÚNICO PARCIAL (receiver, redirectId | type=MATCH): garantiza
 *    a nivel base de datos UNA sola notificación de match por vínculo, aun si dos
 *    pasadas del robot corren a la vez (red de seguridad de la condición de
 *    carrera). Va DESPUÉS de la limpieza: con duplicados presentes, fallaría.
 *
 * Idempotente: tras la primera corrida no quedan duplicados (paso 1 = no-op) y el
 * índice ya existe (paso 2 = no-op). Nunca aborta el boot: los errores se loguean.
 */
import { errorLogger, logger } from '../../shared/logger';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';
import Notification from './notification.model';

let alreadyRan = false;

export const collapseMatchNotifications = async (): Promise<void> => {
    if (alreadyRan) return;
    alreadyRan = true;

    const coll = Notification.collection;

    // --- Paso 1: colapsar duplicados existentes ---
    // Ordenar por createdAt desc ANTES del $group: el $push conserva ese orden, así
    // ids[0] es la más nueva (la que se conserva).
    const groups = await coll
        .aggregate(
            [
                {
                    $match: {
                        type: ENUM_NOTIFICATION_TYPE.MATCH,
                        redirectId: { $ne: null },
                    },
                },
                { $sort: { createdAt: -1 } },
                {
                    $group: {
                        _id: {
                            receiver: '$receiver',
                            redirectId: '$redirectId',
                        },
                        ids: { $push: '$_id' },
                    },
                },
                { $match: { $expr: { $gt: [{ $size: '$ids' }, 1] } } },
            ],
            { allowDiskUse: true }
        )
        .toArray();

    const toDelete: any[] = [];
    for (const g of groups as any[]) {
        // Conservar ids[0] (la más nueva); borrar el resto.
        for (let i = 1; i < g.ids.length; i++) toDelete.push(g.ids[i]);
    }

    if (toDelete.length) {
        const res = await coll.deleteMany({ _id: { $in: toDelete } });
        logger.info(
            `[migration] Notificaciones MATCH colapsadas: ${res.deletedCount} duplicadas borradas en ${groups.length} vínculos.`
        );
    }

    // --- Paso 2: índice único parcial (una MATCH por vínculo) ---
    try {
        await coll.createIndex(
            { receiver: 1, redirectId: 1 },
            {
                unique: true,
                partialFilterExpression: {
                    type: ENUM_NOTIFICATION_TYPE.MATCH,
                },
                name: 'uniq_match_notif_per_vinculo',
            }
        );
    } catch (err) {
        // No aborta el boot: sin el índice, el upsert de sendNotification igual
        // colapsa en la práctica (el robot serializa por bond). Se deja visible.
        errorLogger.error(
            '[migration] createIndex uniq_match_notif_per_vinculo falló:',
            (err as Error)?.message
        );
    }
};

export default collapseMatchNotifications;
