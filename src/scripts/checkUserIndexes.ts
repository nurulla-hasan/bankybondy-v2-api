/* Verifies that User's {isVerified:1, codeExpireIn:1} index was actually CREATED.
 * Mongoose autoIndex builds at startup and fails SILENTLY, so "deployed" and
 * "index exists" are different things. Without it, the incomplete-signup cron
 * (user.services.ts, every 2 min) full-scans the collection forever.
 * Read-only. Usage (after build): node dist/scripts/checkUserIndexes.js
 */
import mongoose from 'mongoose';
import config from '../app/config';
import { User } from '../app/modules/user/user.model';

/* eslint-disable no-console */

const ESPERADO = { isVerified: 1, codeExpireIn: 1 };

const main = async (): Promise<void> => {
    await mongoose.connect(config.database_url as string);
    console.log('[userIdx] DB conectada');

    const idx = (await User.collection.indexes()) as Array<{
        name?: string;
        key?: Record<string, number>;
        unique?: boolean;
        partialFilterExpression?: Record<string, unknown>;
    }>;

    console.log('[userIdx] índices de la colección users:');
    for (const i of idx) {
        const partes = [
            `  - ${i.name}`,
            JSON.stringify(i.key || {}),
            i.unique ? 'UNIQUE' : '',
            i.partialFilterExpression
                ? `PARCIAL ${JSON.stringify(i.partialFilterExpression)}`
                : '',
        ].filter(Boolean);
        console.log(partes.join(' '));
    }

    // Compare key SHAPE, not name (mongoose autogenerates it), and accept by
    // PREFIX: a longer index serves this query too. EXCLUDE partial/sparse/
    // collation — a partial {isVerified:true} index would be a false OK, useless
    // for a query filtering isVerified:false. A false positive is worse than a
    // false negative: it leaves this alarm lying in green.
    const claves = Object.entries(ESPERADO);
    const encontrado = idx.find((i) => {
        if (i.partialFilterExpression || (i as any).sparse || (i as any).collation)
            return false;
        const suyas = Object.entries(i.key || {});
        if (suyas.length < claves.length) return false;
        return claves.every(
            ([k, v], n) => suyas[n][0] === k && suyas[n][1] === v
        );
    });

    if (encontrado) {
        console.log(
            `[userIdx] ✅ OK — el índice existe (${encontrado.name}).`
        );
    } else {
        console.log(
            '[userIdx] ❌ FALTA el índice {isVerified:1, codeExpireIn:1}.'
        );
        console.log(
            '[userIdx]    autoIndex falló en silencio, o el proceso no reinició'
        );
        console.log(
            '[userIdx]    después del deploy. El cron de altas incompletas está'
        );
        console.log(
            '[userIdx]    escaneando la colección entera cada 2 minutos.'
        );
    }

    // How many docs fall on the useful side of the index. If huge, consider a
    // PARTIAL index on {isVerified:false}, proportional to unverified signups.
    const sinVerificar = await User.countDocuments({ isVerified: false });
    const total = await User.estimatedDocumentCount();
    console.log(
        `[userIdx] usuarios: ${total} total, ${sinVerificar} sin verificar`
    );

    await mongoose.connection.close();
    process.exit(encontrado ? 0 : 1);
};

main().catch(async (e) => {
    console.error('[userIdx] ERROR:', (e as Error)?.message);
    try {
        await mongoose.connection.close();
    } catch {
        // already closed
    }
    process.exit(1);
});
