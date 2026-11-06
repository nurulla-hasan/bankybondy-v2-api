/* eslint-disable @typescript-eslint/no-explicit-any */
/* Borrado en cascada al eliminar un usuario (integridad referencial + RGPD).
 *
 * Estrategia por colección:
 *  - Contenido propio del usuario  → se BORRA el documento.
 *  - Relaciones (rating, amistad, relative, report) → se BORRA (cualquier extremo).
 *  - Colecciones COMPARTIDAS (conversaciones, grupos, bondLinks) → se QUITA al
 *    usuario del array de participantes, SIN borrar el documento (para no
 *    destruir datos de los demás participantes).
 *
 * Se opera sobre colecciones nativas para no importar ~24 modelos (evita
 * dependencias circulares). Los nombres son la pluralización por defecto de
 * Mongoose (verificado: ningún modelo define un nombre de colección custom).
 *
 * Todas las referencias apuntan al perfil (NormalUser = profileId).
 */
import mongoose, { ClientSession } from 'mongoose';

export const cascadeDeleteUserData = async (
    profileId: string,
    session?: ClientSession
): Promise<void> => {
    const pid = new mongoose.Types.ObjectId(profileId);
    const db = mongoose.connection.db;
    if (!db) throw new Error('No hay conexión a la base de datos');
    const opts = session ? { session } : {};

    // 1) Borrar el documento (contenido propio + relaciones).
    const deletes: Array<[string, Record<string, unknown>]> = [
        ['audios', { user: pid }],
        ['audiobookmarks', { user: pid }],
        ['bonds', { user: pid }],
        ['bondrequests', { user: pid }],
        ['bondmatches', { users: pid }],
        ['donates', { user: pid }],
        ['playlists', { user: pid }],
        ['transactions', { user: pid }],
        // Feedback que la persona dejó en audios AJENOS. Faltaban las dos: el
        // texto y los feeling tags seguían publicados en
        // `GET /audio/:audioId/feedback` después de que borrara su cuenta (con
        // `commentor: null` tras el populate) y seguían sumando en los conteos.
        // `audioratings` usa `user`; `audiocomments` usa `commentor`.
        ['audioratings', { user: pid }],
        ['audiocomments', { commentor: pid }],
        ['messages', { msgByUserId: pid }],
        ['bondratings', { $or: [{ rated: pid }, { ratedBy: pid }] }],
        ['friendrequests', { $or: [{ sender: pid }, { receiver: pid }] }],
        ['reports', { $or: [{ reportFrom: pid }, { reportTo: pid }] }],
        // Bloqueos: borrar cualquier extremo (bloqueador o bloqueado).
        ['userblocks', { $or: [{ blocker: pid }, { blocked: pid }] }],
        // Notificaciones del usuario. `receiver` es un String con el profileId.
        ['notifications', { receiver: profileId }],
    ];
    // Antes de borrar las reseñas: juntar a los usuarios cuya reputación quedará
    // desactualizada — los que ESTE usuario calificó (rated != pid). Los
    // `bondratings` se borran con el driver nativo (más abajo), que NO dispara los
    // hooks de Mongoose que recalculan la reputación cacheada de NormalUser. Sin
    // esto, tras borrar la cuenta esas personas conservan un promedio/score que ya
    // no se corresponde con sus reseñas reales (y el orden por reputación miente).
    const affectedRatedDocs = await db
        .collection('bondratings')
        .find(
            { ratedBy: pid, rated: { $ne: pid } },
            { ...(opts as any), projection: { rated: 1 } }
        )
        .toArray();
    const affectedRatedIds = Array.from(
        new Set(affectedRatedDocs.map((d: any) => String(d.rated)))
    );

    for (const [name, filter] of deletes) {
        await db.collection(name).deleteMany(filter as any, opts as any);
    }

    // Ya con las reseñas borradas, recomputar la reputación de los afectados. Se
    // pasa la sesión para que el recálculo vea el estado post-borrado y quede
    // dentro de la misma transacción.
    if (affectedRatedIds.length) {
        const { recomputeReputation } = await import(
            '../bondRating/reputation.util'
        );
        for (const ratedId of affectedRatedIds) {
            await recomputeReputation(ratedId, session);
        }
    }

    // 2) Colecciones compartidas: quitar al usuario del array (no borrar el doc).
    // Incluye los arrays de referencia "sueltos" que quedaban con el id colgado de
    // una cuenta ya borrada: `hiddenBy` (quién ocultó una conversación), `seenBy`
    // (quién vio un mensaje) y `markAsCompletedBy` (quién marcó completado un
    // BondLink). No rompían nada, pero dejaban ids fantasma que inflaban lecturas.
    // (`creator` de chatGroup queda fuera a propósito: es ref simple, no array;
    // desetearla podría romper el render del grupo y un id colgado ahí es inocuo.)
    const pulls: Array<[string, string]> = [
        ['conversations', 'participants'],
        ['conversations', 'hiddenBy'],
        ['chatgroups', 'participants'],
        ['bondlinks', 'participants'],
        ['bondlinks', 'markAsCompletedBy'],
        ['messages', 'seenBy'],
    ];
    for (const [name, field] of pulls) {
        await db.collection(name).updateMany(
            { [field]: pid } as any,
            { $pull: { [field]: pid } } as any,
            opts as any
        );
    }
};

export default cascadeDeleteUserData;
