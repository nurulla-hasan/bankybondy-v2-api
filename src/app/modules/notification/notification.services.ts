/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { JwtPayload } from 'jsonwebtoken';
import { USER_ROLE } from '../user/user.constant';
import QueryBuilder from '../../builder/QueryBuilder';
import Notification from './notification.model';
import AppError from '../../error/appError';
import httpStatus from 'http-status';
import getUserNotificationCount from '../../helper/getUserNotificationCount';
import NormalUser from '../normalUser/normalUser.model';
import { getBlockedIdsFor } from '../userBlock/userBlock.service';
import {
    NOTIFICATION_CATEGORIES,
    mutedTypesFromCategories,
    sanitizeCategories,
} from './notification.categories';
// import getAdminNotificationCount from '../../helper/getAdminNotification';
// import getUnseenNotificationCount from '../../helper/getUnseenNotification';

const getAllNotificationFromDB = async (
    query: Record<string, any>,
    user: JwtPayload
) => {
    if (user?.role === USER_ROLE.superAdmin) {
        const notificationQuery = new QueryBuilder(
            Notification.find({ receiver: USER_ROLE.superAdmin }),
            query
        )
            .search(['name'])
            .filter()
            .sort()
            .paginate()
            .fields();
        const result = await notificationQuery.modelQuery;
        const meta = await notificationQuery.countTotal();
        return { meta, result };
    } else {
        // Excluir notificaciones cuyo actor (redirectId, string) sea un usuario
        // bloqueado en cualquier direccion. Un `$nin` no descarta docs con
        // redirectId null/ausente (notificaciones de sistema), asi que esas se
        // siguen mostrando.
        const blockedIds = await getBlockedIdsFor(String(user.profileId));
        // Silenciado por categoría (opción a): lo muteado NO se muestra NI cuenta,
        // así "todo lo que se ve descuenta el badge". Mismo criterio que el conteo
        // (getUserNotificationCount) → lista y badge quedan alineados.
        const me = await NormalUser.findById(user.profileId)
            .select('mutedNotificationCategories')
            .lean();
        const mutedTypes = mutedTypesFromCategories(
            (me as any)?.mutedNotificationCategories
        );
        const baseFilter: Record<string, any> = {
            $or: [{ receiver: user.profileId }, { receiver: 'all' }],
            deleteBy: { $ne: user.profileId },
            redirectId: { $nin: blockedIds },
        };
        if (mutedTypes.length) baseFilter.type = { $nin: mutedTypes };
        const notificationQuery = new QueryBuilder(
            Notification.find(baseFilter).select({
                seenBy: 0,
                deleteBy: 0,
                notifiedSignatures: 0,
            }),
            query
        )
            .search(['name'])
            .filter()
            .sort()
            .paginate()
            .fields();
        const result = await notificationQuery.modelQuery;
        const meta = await notificationQuery.countTotal();
        return { meta, result };
    }
};

// Conteo de no vistas (+ última) del usuario. Usa el MISMO helper que el socket
// (getUserNotificationCount), así el número inicial y el que llega en vivo por el
// evento 'notification' son siempre consistentes.
const getUnseenCount = async (user: JwtPayload) => {
    return getUserNotificationCount(String(user?.profileId));
};

const seeNotification = async (user: JwtPayload) => {
    let result;
    if (user?.role === USER_ROLE.superAdmin) {
        // Marcar como vistas las notificaciones del admin agregando su profileId
        // a `seenBy` (el schema NO tiene campo `seen`; antes se escribia a un
        // campo fantasma y el "marcar como visto" del admin no registraba nada).
        result = await Notification.updateMany(
            { $or: [{ receiver: USER_ROLE.superAdmin }, { receiver: 'all' }] },
            { $addToSet: { seenBy: user?.profileId } },
            { runValidators: true }
        );
        // const adminUnseenNotificationCount = await getAdminNotificationCount();
        //@ts-ignore
        // global.io.emit('admin-notifications', adminUnseenNotificationCount);
    } else {
        result = await Notification.updateMany(
            { $or: [{ receiver: user?.profileId }, { receiver: 'all' }] },
            { $addToSet: { seenBy: user?.profileId } },
            { runValidators: true }
        );
    }
    //   const updatedNotificationCount = await getUnseenNotificationCount(
    //     user?.userId,
    //   );
    //@ts-ignore
    //   global.io.to(user?.userId).emit('notifications', updatedNotificationCount);
    return result;
};

// Marca UNA notificación como vista (agrega el profileId del usuario a su
// `seenBy`). Se usa cuando el usuario ABRE una notificación puntual (no al abrir
// la campana): así el badge baja de a una, sólo por las que realmente abre.
const seeOneNotification = async (user: JwtPayload, id: string) => {
    const receiverKey =
        user?.role === USER_ROLE.superAdmin
            ? USER_ROLE.superAdmin
            : user?.profileId;
    return Notification.updateOne(
        { _id: id, $or: [{ receiver: receiverKey }, { receiver: 'all' }] },
        { $addToSet: { seenBy: user?.profileId } },
        { runValidators: true }
    );
};

// delete notificaiton
const deleteNoficiation = async (id: string, profileId: string) => {
    const notification = await Notification.findOne({ _id: id, $or: [{ receiver: 'all' }, { receiver: profileId }] });
    if (!notification) {
        throw new AppError(httpStatus.NOT_FOUND, 'Notification not found');
    }
    if (notification.receiver == profileId) {
        await Notification.findByIdAndDelete(id);
        return null;
    } else {
        await Notification.findByIdAndUpdate(id, {
            $addToSet: { deleteBy: profileId },
        });
        return null;
    }
};

// Preferencias de silenciado (Tanda C): traer las categorías silenciadas del
// usuario + la lista de categorías válidas (para que el front dibuje los toggles).
const getPreferences = async (user: JwtPayload) => {
    const me = await NormalUser.findById(user?.profileId)
        .select('mutedNotificationCategories')
        .lean();
    return {
        mutedCategories:
            (me as any)?.mutedNotificationCategories ?? ([] as string[]),
        categories: NOTIFICATION_CATEGORIES,
    };
};

// Guardar el set completo de categorías silenciadas (el front manda el estado
// final). Se saneia contra la lista válida: cualquier valor raro se descarta.
const updatePreferences = async (user: JwtPayload, mutedCategories: unknown) => {
    // F3.4: rechazar body malformado en vez de VACIAR todos los mutes. Antes, un
    // body NO-array (o sin `mutedCategories`) caía a `[]` en sanitizeCategories y
    // borraba silenciosamente todas las categorías silenciadas del usuario.
    if (!Array.isArray(mutedCategories)) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'mutedCategories debe ser un array.'
        );
    }
    const clean = sanitizeCategories(mutedCategories);
    const updated = await NormalUser.findByIdAndUpdate(
        user?.profileId,
        { $set: { mutedNotificationCategories: clean } },
        { new: true }
    )
        .select('mutedNotificationCategories')
        .lean();
    return {
        mutedCategories:
            (updated as any)?.mutedNotificationCategories ?? ([] as string[]),
    };
};

const notificationService = {
    getAllNotificationFromDB,
    getUnseenCount,
    seeNotification,
    seeOneNotification,
    deleteNoficiation,
    getPreferences,
    updatePreferences,
};

export default notificationService;
