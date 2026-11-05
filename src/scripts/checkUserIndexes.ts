/* Verifica que el índice {isVerified:1, codeExpireIn:1} de User haya quedado
 * CREADO en la base. Calcado de checkFriendRequestIndexes.ts, y por el mismo
 * motivo: `autoIndex` de Mongoose construye los índices al arrancar el proceso,
 * y SI FALLA LO HACE EN SILENCIO. Sin este chequeo, "está deployado" y "el
 * índice existe" son dos cosas distintas que se parecen.
 *
 * Para qué sirve ese índice: el cron de limpieza de altas incompletas corre
 * CADA 2 MINUTOS (user.services.ts) y consulta
 * `{ isVerified:false, codeExpireIn:{$lte}, createdAt:{$gte} }`. La colección no
 * tenía más índice que el `unique` de email, así que eso era un ESCANEO DE
 * COLECCIÓN COMPLETA cada 2 minutos, para siempre.
 *
 * Solo LEE. No crea ni borra nada.
 *
 * Uso (tras compilar):
 *   node dist/scripts/checkUserIndexes.js
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

    // Se compara la FORMA de la clave, no el nombre: mongoose lo autogenera y
    // podría cambiar. El orden importa (igualdad antes que rango).
    //
    // Se acepta por PREFIJO, no por igualdad exacta: un índice
    // {isVerified:1, codeExpireIn:1, createdAt:1} sirve para esta query igual o
    // mejor, y con igualdad exacta se habría reportado como FALTANTE — una alarma
    // mentirosa, que es peor que no tener alarma.
    // Y se EXCLUYEN los índices parciales/sparse/con collation. Sin esto, el
    // chequeo por prefijo abría un FALSO POSITIVO: un índice con la misma clave
    // pero `partialFilterExpression:{isVerified:true}` se reportaría ✅ OK siendo
    // INÚTIL para una query que filtra `isVerified:false`. Y no es rebuscado — el
    // pie de este mismo script sugiere evaluar un índice parcial más adelante.
    // Un falso positivo es peor que un falso negativo: deja al script mintiendo
    // en verde, que es exactamente lo que esta alarma existe para no hacer.
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

    // Cuántos documentos caen del lado útil del índice. Si esto es enorme, vale
    // la pena evaluar un índice PARCIAL sobre {isVerified:false}, que pesaría en
    // proporción a las altas sin verificar y no a toda la colección.
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
        // ya estaba cerrada
    }
    process.exit(1);
});
