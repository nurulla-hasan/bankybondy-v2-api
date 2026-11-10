/* Dedupe PENDING FriendRequests (same sender+receiver) so the partial unique index
 * can be built. APPLY=1 deletes duplicates keeping the OLDEST; default is read-only.
 * Usage: node dist/scripts/dedupeFriendRequests.js [APPLY=1]  (one-off, idempotent)
 */
import mongoose from 'mongoose';
import config from '../app/config';
import FriendRequest from '../app/modules/friendRequest/friendRequest.model';
import { ENUM_FRIEND_REQUEST_STATUS } from '../app/modules/friendRequest/friendRequest.enum';

/* eslint-disable no-console */

const APPLY = process.env.APPLY === '1';

const main = async (): Promise<void> => {
    await mongoose.connect(config.database_url as string);
    console.log('[dedupeFR] DB connected');
    console.log(
        `[dedupeFR] modo: ${APPLY ? 'APPLY (borra)' : 'READ-ONLY (solo cuenta)'}`
    );

    // Overall breakdown by status (informational).
    const total = await FriendRequest.estimatedDocumentCount();
    const byStatus = await FriendRequest.aggregate([
        { $group: { _id: '$status', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
    ]);
    console.log(`[dedupeFR] total friendRequests: ${total}`);
    for (const s of byStatus as Array<{ _id: string; n: number }>) {
        console.log(`[dedupeFR]   ${s._id ?? '(sin status)'}: ${s.n}`);
    }

    // PENDING groups with identical (sender, receiver) and more than one doc:
    // what would break the partial unique index. Sorted by createdAt asc, so the
    // oldest comes first and is the one kept.
    const groups = await FriendRequest.aggregate([
        { $match: { status: ENUM_FRIEND_REQUEST_STATUS.Pending } },
        { $sort: { createdAt: 1 } },
        {
            $group: {
                _id: { sender: '$sender', receiver: '$receiver' },
                ids: { $push: '$_id' },
                n: { $sum: 1 },
            },
        },
        { $match: { n: { $gt: 1 } } },
        { $sort: { n: -1 } },
    ]);

    const docsToRemove = (groups as Array<{ n: number }>).reduce(
        (acc, g) => acc + (g.n - 1),
        0
    );
    console.log(
        `[dedupeFR] pares (sender,receiver) PENDING duplicados: ${groups.length}`
    );
    console.log(
        `[dedupeFR] docs PENDING que sobran (se borrarían): ${docsToRemove}`
    );
    // Show the worst 10 for context (ids only, nothing sensitive).
    (groups as Array<{ _id: { sender: unknown; receiver: unknown }; n: number }>)
        .slice(0, 10)
        .forEach((g, i) => {
            console.log(
                `[dedupeFR]   #${i + 1} sender=${g._id.sender} receiver=${g._id.receiver} -> ${g.n} copias`
            );
        });

    // Informational (NOT deleted): pairs PENDING in BOTH directions (A->B and
    // B->A). The single-direction index leaves them untouched.
    const pendingPairs = await FriendRequest.aggregate([
        { $match: { status: ENUM_FRIEND_REQUEST_STATUS.Pending } },
        { $group: { _id: { sender: '$sender', receiver: '$receiver' } } },
    ]);
    const dirSet = new Set(
        (pendingPairs as Array<{ _id: { sender: unknown; receiver: unknown } }>).map(
            (p) => `${p._id.sender}->${p._id.receiver}`
        )
    );
    let bidirectional = 0;
    for (const key of dirSet) {
        const [a, b] = key.split('->');
        if (dirSet.has(`${b}->${a}`)) bidirectional += 1;
    }
    // Each bidirectional pair is counted twice (A->B and B->A), so divide by 2.
    console.log(
        `[dedupeFR] (informativo) pares PENDING en ambos sentidos: ${bidirectional / 2}`
    );

    if (!APPLY) {
        console.log(
            '[dedupeFR] READ-ONLY: no se borró nada. Para limpiar: APPLY=1 node dist/scripts/dedupeFriendRequests.js'
        );
        return;
    }

    // APPLY: keep ids[0] (oldest) of each group, delete the rest.
    let removed = 0;
    for (const g of groups as Array<{ ids: mongoose.Types.ObjectId[] }>) {
        const [, ...toDelete] = g.ids;
        if (toDelete.length) {
            const res = await FriendRequest.deleteMany({
                _id: { $in: toDelete },
            });
            removed += res.deletedCount || 0;
        }
    }
    console.log(`[dedupeFR] APPLY done. duplicados PENDING borrados=${removed}`);
};

main()
    .then(async () => {
        await mongoose.connection.close();
        process.exit(0);
    })
    .catch(async (err) => {
        console.error('[dedupeFR] FALLO:', err);
        await mongoose.connection.close().catch(() => undefined);
        process.exit(1);
    });
