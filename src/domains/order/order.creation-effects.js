import { invalidateProductCaches } from "../product/productCache.service.js";
import { sendNewOrderNotificationToAdminsAndModerators } from "../notification/notification.service.js";
import { orderStatusEnum } from "../../shared/constants/enums.js";

// Call only after the order transaction has committed.
export async function runOrderCreatedEffects(order) {
  const productIds = Array.isArray(order.items) ? order.items.map(item => item.product) : [];
  await invalidateProductCaches(productIds);
  if (order.status !== orderStatusEnum.PENDING) return;
  sendNewOrderNotificationToAdminsAndModerators(order).catch(error =>
    console.error("[Order] Failed to send new order notification to admins/moderators:", error.message));
}
