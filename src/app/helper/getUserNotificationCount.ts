import mongoose from 'mongoose';
import Notification from '../modules/notification/notification.model';
import NormalUser from '../modules/normalUser/normalUser.model';
import { mutedTypesFromCategories } from '../modules/notification/notification.categories';
import { getBlockedIdsFor } from '../modules/userBlock/userBlock.service';

const getUserNotificationCount = async (receiver: string) => {
    // Silenciado por categoría (Tanda C): las categorías que el usuario silenció
    // NO suman al globito y (opción a, Tanda N) tampoco aparecen en la lista de la
    // campana. La notificación IGUAL se crea; acá se excluyen del conteo de no vistas
    // (el mismo filtro se aplica a la lista en getAllNotificationFromDB).
    let mutedTypes: string[] = [];
    if (mongoose.Types.ObjectId.isValid(receiver)) {
        const me = await NormalUser.findById(receiver)
            .select('mutedNotificationCategories')
            .lean();
        mutedTypes = mutedTypesFromCategories(
            (me as any)?.mutedNotificationCategories
        );
    }

    // Unificado sobre `seenBy` (el schema NO tiene campo `seen`, por eso el
    // conteo daba SIEMPRE 0). Cuenta las notificaciones que el usuario no vio.
    // Mismos filtros que el LISTADO (getAllNotificationFromDB): excluir las que el
    // usuario borró (deleteBy) y las de un actor bloqueado (redirectId $nin). Antes
    // el conteo/último NO los aplicaban → el globito contaba/mostraba ítems que la
    // lista ocultaba (badge > items).
    const blockedIds = mongoose.Types.ObjectId.isValid(receiver)
        ? await getBlockedIdsFor(receiver)
        : [];
    const filter: Record<string, any> = {
        // Incluye los broadcasts (receiver:'all') igual que el listado y el
        // "marcar visto". Antes el conteo hacía match exacto de receiver → los
        // broadcasts aparecían en la lista pero NO sumaban al globito.
        $or: [{ receiver }, { receiver: 'all' }],
        seenBy: { $ne: new mongoose.Types.ObjectId(receiver) },
        deleteBy: { $ne: new mongoose.Types.ObjectId(receiver) },
        redirectId: { $nin: blockedIds },
    };
    if (mutedTypes.length) {
        filter.type = { $nin: mutedTypes };
    }

    const unseenCount = await Notification.countDocuments(filter);
    const latestNotification = await Notification.findOne({
        $or: [{ receiver }, { receiver: 'all' }],
        deleteBy: { $ne: new mongoose.Types.ObjectId(receiver) },
        redirectId: { $nin: blockedIds },
    })
        .sort({ createdAt: -1 })
        .lean();
    return { unseenCount, latestNotification };
};

export default getUserNotificationCount;
