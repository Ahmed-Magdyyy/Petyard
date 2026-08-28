import {
  dispatchNotification,
  dispatchNotificationToUsers,
  dispatchNotificationToGuests,
} from "../notification/notificationDispatcher.js";
import { UserModel } from "../user/user.model.js";
import { roles } from "../../shared/constants/enums.js";

async function dispatchToSuperAdmins(payload) {
  const superAdmins = await UserModel.find({
    active: true,
    role: roles.SUPER_ADMIN,
  }).select("_id");

  const userIds = superAdmins.map((user) => String(user._id));
  if (!userIds.length) {
    return { skipped: true, reason: "no_recipients" };
  }

  return dispatchNotificationToUsers({
    ...payload,
    userIds,
  });
}

// An object indirection keeps the dispatcher easy to replace in focused tests.
export const restockNotificationGateway = {
  dispatch: dispatchNotification,
  dispatchToGuests: dispatchNotificationToGuests,
  dispatchToSuperAdmins,
};
