/* Verifies that the PARTIAL unique index {sender,receiver} status:Pending on
 * FriendRequest was actually CREATED (Mongoose autoIndex builds it on startup and
 * fails SILENTLY). Read-only.
 *
 * Usage (after compiling and restarting the API):
 *   node dist/scripts/checkFriendRequestIndexes.js
 */
import mongoose from 'mongoose';
import config from '../app/config';
import FriendRequest from '../app/modules/friendRequest/friendRequest.model';

/* eslint-disable no-console */

const main = async (): Promise<void> => {
    await mongoose.connect(config.database_url as string);
    console.log('[frIdx] DB connected');

    const idx = (await FriendRequest.collection.indexes()) as Array<{
        name?: string;
        key?: Record<string, number>;
        unique?: boolean;
        partialFilterExpression?: Record<string, unknown>;
    }>;

    console.log('[frIdx] índices de la colección friendrequests:');
    for (const i of idx) {
        const parts = [
            `  - ${i.name}`,
            JSON.stringify(i.key || {}),
            i.unique ? 'UNIQUE' : '',
            i.partialFilterExpression
                ? `PARTIAL ${JSON.stringify(i.partialFilterExpression)}`
                : '',
        ].filter(Boolean);
        console.log(parts.join('  '));
    }

    const target = idx.find(
        (i) =>
            i.key &&
            i.key.sender === 1 &&
            i.key.receiver === 1 &&
            i.unique === true
    );
    if (target) {
        console.log(
            `[frIdx] OK: índice único {sender,receiver} PRESENTE (name=${target.name}).`
        );
    } else {
        console.log(
            '[frIdx] ATENCION: NO está el índice único {sender,receiver}. Revisar los logs de la API (autoIndex pudo fallar en silencio).'
        );
    }
};

main()
    .then(async () => {
        await mongoose.connection.close();
        process.exit(0);
    })
    .catch(async (err) => {
        console.error('[frIdx] FALLO:', err);
        await mongoose.connection.close().catch(() => undefined);
        process.exit(1);
    });
