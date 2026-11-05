import httpStatus from 'http-status';
import mongoose, { Types } from 'mongoose';
import QueryBuilder from '../../builder/QueryBuilder';
import AppError from '../../error/appError';
import NormalUser from '../normalUser/normalUser.model';
import UserBlock from './userBlock.model';

/**
 * Helper reutilizable: devuelve los ids (como string) que el usuario bloqueo
 * MAS los ids que lo bloquearon a el. Se usa para excluir contenido de/para
 * usuarios bloqueados en los endpoints de lectura clave.
 *
 * Devuelve strings para poder comparar/filtrar en JS con facilidad; usar
 * `getBlockedObjectIdsFor` cuando se necesiten ObjectId para un `$nin`.
 */
export const getBlockedIdsFor = async (userId: string): Promise<string[]> => {
    const uid = new Types.ObjectId(userId);
    const rows = await UserBlock.find({
        $or: [{ blocker: uid }, { blocked: uid }],
    })
        .select('blocker blocked')
        .lean();

    const ids = new Set<string>();
    for (const row of rows) {
        const blocker = row.blocker?.toString();
        const blocked = row.blocked?.toString();
        // Agregar el "otro" extremo de la relacion (nunca el propio usuario).
        if (blocker && blocker !== userId) ids.add(blocker);
        if (blocked && blocked !== userId) ids.add(blocked);
    }
    return [...ids];
};

/**
 * Igual que getBlockedIdsFor pero devuelve ObjectId[], listo para usar en un
 * `{ $nin: [...] }` de mongoose/aggregation.
 */
export const getBlockedObjectIdsFor = async (
    userId: string
): Promise<Types.ObjectId[]> => {
    const ids = await getBlockedIdsFor(userId);
    return ids.map((id) => new Types.ObjectId(id));
};

/**
 * Devuelve el PRIMER par con relacion de bloqueo (en cualquier sentido) dentro
 * de un conjunto de usuarios, o null si estan todos limpios entre si.
 *
 * Existe porque un vinculo grupal es una conversacion de TODOS contra TODOS: no
 * alcanza con mirar al que lo crea. En un vinculo de tres (A crea con B y C), si
 * B bloqueo a C, el bloqueo se ignoraba y B y C terminaban en el mismo chat.
 * `getBlockedIdsFor` responde por UN usuario; para cubrir todos los pares harian
 * falta N consultas. Aca alcanza UNA: si existe una fila cuyo blocker Y cuyo
 * blocked estan ambos en el conjunto, ese es un par bloqueado.
 */
export const findBlockedPairAmong = async (
    userIds: (string | Types.ObjectId)[]
): Promise<{ blocker: string; blocked: string } | null> => {
    const unique = Array.from(
        new Set(userIds.filter(Boolean).map((id) => id.toString()))
    ).filter((id) => Types.ObjectId.isValid(id));
    // Con 0 o 1 participante no hay pares posibles.
    if (unique.length < 2) return null;

    const objectIds = unique.map((id) => new Types.ObjectId(id));
    const row = await UserBlock.findOne({
        blocker: { $in: objectIds },
        blocked: { $in: objectIds },
    })
        .select('blocker blocked')
        .lean();

    if (!row) return null;
    return {
        blocker: row.blocker?.toString(),
        blocked: row.blocked?.toString(),
    };
};

const blockUser = async (blockerId: string, blockedId: string) => {
    if (blockerId === blockedId) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'You can not block yourself'
        );
    }
    if (!mongoose.Types.ObjectId.isValid(blockedId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid user id');
    }
    const target = await NormalUser.findById(blockedId).select('_id');
    if (!target) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    try {
        const result = await UserBlock.create({
            blocker: blockerId,
            blocked: blockedId,
        });
        return result;
    } catch (error: unknown) {
        // Ya estaba bloqueado (indice unico): idempotente, no es un error.
        if ((error as { code?: number })?.code === 11000) {
            return await UserBlock.findOne({
                blocker: blockerId,
                blocked: blockedId,
            });
        }
        throw error;
    }
};

const unblockUser = async (blockerId: string, blockedId: string) => {
    const result = await UserBlock.findOneAndDelete({
        blocker: blockerId,
        blocked: blockedId,
    });
    if (!result) {
        throw new AppError(
            httpStatus.NOT_FOUND,
            'This user is not in your block list'
        );
    }
    return result;
};

const getMyBlockedUsers = async (
    blockerId: string,
    query: Record<string, unknown>
) => {
    const blockQuery = new QueryBuilder(
        UserBlock.find({ blocker: blockerId }).populate({
            path: 'blocked',
            // Sin `email`: bloquear a alguien es una acción disponible para
            // cualquier usuario autenticado, así que con bloquear un profileId
            // válido y leer esta lista se obtenía su mail. No hace falta para
            // reconocer a quién bloqueaste: alcanzan el nombre y la foto.
            select: 'name profile_image',
        }),
        query
    )
        .filter()
        .sort()
        .paginate()
        .fields();

    const result = await blockQuery.modelQuery;
    const meta = await blockQuery.countTotal();
    return { meta, result };
};

const userBlockServices = {
    getBlockedIdsFor,
    getBlockedObjectIdsFor,
    findBlockedPairAmong,
    blockUser,
    unblockUser,
    getMyBlockedUsers,
};

export default userBlockServices;
