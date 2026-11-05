/* Conteo + limpieza de FriendRequest PENDING duplicadas (mismo sender+receiver).
 *
 * Por qué: se quiere un índice único PARCIAL sobre { sender, receiver } con
 * status:Pending (friendRequest.model.ts) para cerrar la carrera pura de
 * doble-tap. Si ya existen duplicados PENDING con el mismo (sender, receiver),
 * la construcción del índice falla (E11000). Este script los detecta y, en modo
 * APPLY, conserva el MÁS VIEJO de cada grupo y borra el resto.
 *
 * SEGURO POR DEFECTO: sin APPLY solo REPORTA (no borra nada). Idempotente.
 *
 * Uso (tras compilar con `npx tsc`, parado en ~/bb-nuevo):
 *   node dist/scripts/dedupeFriendRequests.js          # SOLO CUENTA (read-only)
 *   APPLY=1 node dist/scripts/dedupeFriendRequests.js  # borra los duplicados
 *
 * NO reinicia procesos ni toca el server: es una tarea de una sola vez.
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

    // Panorama general por estado (informativo).
    const total = await FriendRequest.estimatedDocumentCount();
    const byStatus = await FriendRequest.aggregate([
        { $group: { _id: '$status', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
    ]);
    console.log(`[dedupeFR] total friendRequests: ${total}`);
    for (const s of byStatus as Array<{ _id: string; n: number }>) {
        console.log(`[dedupeFR]   ${s._id ?? '(sin status)'}: ${s.n}`);
    }

    // Grupos PENDING con (sender, receiver) idénticos y más de uno = lo que
    // rompería el índice único parcial. Se ordena por createdAt asc: el más
    // viejo queda primero (es el que se conserva).
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
    // Muestra los peores 10 para dar contexto (sin exponer nada sensible: solo ids).
    (groups as Array<{ _id: { sender: unknown; receiver: unknown }; n: number }>)
        .slice(0, 10)
        .forEach((g, i) => {
            console.log(
                `[dedupeFR]   #${i + 1} sender=${g._id.sender} receiver=${g._id.receiver} -> ${g.n} copias`
            );
        });

    // Informativo (NO se borra): pares con PENDING en AMBOS sentidos (A->B y
    // B->A). El índice único de una dirección no los toca; se listan por si
    // interesa como dato de producto, pero quedan intactos.
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
    // Se cuenta cada par dos veces (A->B y B->A), así que se divide.
    console.log(
        `[dedupeFR] (informativo) pares PENDING en ambos sentidos: ${bidirectional / 2}`
    );

    if (!APPLY) {
        console.log(
            '[dedupeFR] READ-ONLY: no se borró nada. Para limpiar: APPLY=1 node dist/scripts/dedupeFriendRequests.js'
        );
        return;
    }

    // APPLY: conserva ids[0] (el más viejo) de cada grupo, borra el resto.
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
