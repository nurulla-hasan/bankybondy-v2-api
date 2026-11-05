import mongoose from 'mongoose';
import Notification from '../modules/notification/notification.model';

const getNotificationCount = async (receiver: string = '') => {
  // No vistas = el id del usuario NO esta en `seenBy` (antes usaba $eq, que
  // contaba al reves). Guardado por receiver valido.
  const receiverId = receiver ? new mongoose.Types.ObjectId(receiver) : undefined;
  const unseenCount = await Notification.countDocuments({
    ...(receiverId ? { seenBy: { $ne: receiverId } } : {}),
    $or: [{ receiver: receiver }, { receiver: 'all' }],
  });
  const latestNotification = await Notification.findOne({
    $or: [{ receiver: receiver }, { receiver: 'all' }],
  })
    .sort({ createdAt: -1 })
    .lean();
  return { unseenCount, latestNotification };
};

export default getNotificationCount;
