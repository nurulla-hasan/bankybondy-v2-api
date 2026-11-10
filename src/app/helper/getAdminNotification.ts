import mongoose from 'mongoose';
import Notification from '../modules/notification/notification.model';
import { USER_ROLE } from '../modules/user/user.constant';

const getAdminNotificationCount = async (adminId?: string) => {
  // Unseen by THIS admin = profileId not in `seenBy` (the old check compared the
  // array against the 'superAdmin' role and never matched). Needs the admin id.
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
