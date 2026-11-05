import mongoose from 'mongoose';
import Notification from '../modules/notification/notification.model';
import { USER_ROLE } from '../modules/user/user.constant';

const getAdminNotificationCount = async (adminId?: string) => {
  // No vistas por ESTE admin = su profileId NO esta en `seenBy` (antes comparaba
  // el array con el ROL 'superAdmin', que nunca casaba). Requiere el id del admin.
  const adminObjId = adminId ? new mongoose.Types.ObjectId(adminId) : undefined;
  const unseenCount = await Notification.countDocuments({
    ...(adminObjId ? { seenBy: { $ne: adminObjId } } : {}),
    $or: [{ receiver: USER_ROLE.superAdmin }, { receiver: 'all' }],
  });
  const latestNotification = await Notification.findOne({
    $or: [{ receiver: USER_ROLE.superAdmin }, { receiver: 'all' }],
  })
    .sort({ createdAt: -1 })
    .lean();
  return { unseenCount, latestNotification };
};

export default getAdminNotificationCount;
