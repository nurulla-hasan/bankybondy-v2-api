/* eslint-disable @typescript-eslint/no-explicit-any */
/* Cascade delete when a user is removed (referential integrity + GDPR).
 * Own content and relations are deleted; shared collections (conversations,
 * groups, bondLinks) only pull the user from their arrays.
 * Uses native collections to avoid importing ~24 models. All refs use profileId.
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

    // 1) Delete documents (own content + relations).
    const deletes: Array<[string, Record<string, unknown>]> = [
        ['audios', { user: pid }],
        ['audiobookmarks', { user: pid }],
        ['bonds', { user: pid }],
        ['bondrequests', { user: pid }],
        ['bondmatches', { users: pid }],
        ['donates', { user: pid }],
        ['playlists', { user: pid }],
        ['transactions', { user: pid }],
        // Feedback left on others' audios: otherwise it stays published (with
        // `commentor: null`) and keeps counting. audioratings uses `user`,
        // audiocomments uses `commentor`.
        ['audioratings', { user: pid }],
        ['audiocomments', { commentor: pid }],
        ['messages', { msgByUserId: pid }],
        ['bondratings', { $or: [{ rated: pid }, { ratedBy: pid }] }],
        ['friendrequests', { $or: [{ sender: pid }, { receiver: pid }] }],
        ['reports', { $or: [{ reportFrom: pid }, { reportTo: pid }] }],
        // Blocks: delete either end.
        ['userblocks', { $or: [{ blocker: pid }, { blocked: pid }] }],
        // `receiver` is a String holding the profileId.
        ['notifications', { receiver: profileId }],
    ];
    // Collect users this account rated (rated != pid) before deleting: native
    // deletes skip the Mongoose hooks that recompute the cached reputation.
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

    // Recompute the affected users now that the ratings are gone; the session
    // keeps it inside the same transaction.
    if (affectedRatedIds.length) {
        const { recomputeReputation } = await import(
            '../bondRating/reputation.util'
        );
        for (const ratedId of affectedRatedIds) {
            await recomputeReputation(ratedId, session);
        }
    }

    // 2) Shared collections: pull the user from arrays, never delete the doc.
    // Also clears loose reference arrays (hiddenBy, seenBy, markAsCompletedBy).
    // chatGroup.creator is a single ref and intentionally left as-is.
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
