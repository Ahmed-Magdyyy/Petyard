import {
  dispatchNotificationToGuests,
  dispatchNotificationToUsers,
} from "../notification/notificationDispatcher.js";

// Keeping the external dependency behind this adapter permits focused domain
// tests without changing the shared notification dispatcher.
export const subcategorySubscriptionNotificationDispatcher = {
  dispatchNotificationToUsers(payload) {
    return dispatchNotificationToUsers(payload);
  },
  dispatchNotificationToGuests(payload) {
    return dispatchNotificationToGuests(payload);
  },
};
