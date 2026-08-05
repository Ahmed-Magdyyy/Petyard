import {
  dispatchNotification,
  dispatchNotificationToGuests,
} from "../notification/notificationDispatcher.js";

// An object indirection keeps the dispatcher easy to replace in focused tests.
export const restockNotificationGateway = {
  dispatch: dispatchNotification,
  dispatchToGuests: dispatchNotificationToGuests,
};
