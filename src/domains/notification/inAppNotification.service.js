import { InAppNotificationModel } from "./inAppNotification.model.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import { buildPagination } from "../../shared/utils/apiFeatures.js";

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
}

/**
 * Create a new in-app notification for a user
 */
export async function createInAppNotificationService({
  userId,
  title_en,
  title_ar,
  body_en,
  body_ar,
  icon = "system",
  action,
  source,
  expiresAt,
}) {
  if (!userId) {
    return null;
  }

  const notification = await InAppNotificationModel.create({
    user: userId,
    title_en,
    title_ar: title_ar || title_en,
    body_en,
    body_ar: body_ar || body_en,
    icon,
    action: action || {},
    source: source || {},
    expiresAt,
  });

  return notification;
}

/**
 * Create multiple in-app notifications for multiple users (batch)
 */
export async function createBulkInAppNotificationsService({
  userIds,
  title_en,
  title_ar,
  body_en,
  body_ar,
  icon = "system",
  action,
  source,
  expiresAt,
}) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return { insertedCount: 0 };
  }

  const docs = userIds.map((userId) => ({
    user: userId,
    title_en,
    title_ar: title_ar || title_en,
    body_en,
    body_ar: body_ar || body_en,
    icon,
    action: action || {},
    source: source || {},
    expiresAt,
  }));

  const result = await InAppNotificationModel.insertMany(docs, {
    ordered: false,
  });

  return { insertedCount: result.length };
}

/**
 * Map notification document to response DTO
 */
function mapNotificationToResponse(notification, lang) {
  const normalizedLang = normalizeLang(lang);

  return {
    id: notification._id,
    title: pickLocalizedField(notification, "title", normalizedLang),
    body: pickLocalizedField(notification, "body", normalizedLang),
    icon: notification.icon || "system",
    action: notification.action || null,
    isRead: notification.isRead || false,
    createdAt: notification.createdAt,
  };
}

/**
 * Get paginated notifications for a user
 * Returns format: { totalPages, page, results, data }
 */
export async function getMyNotificationsService({
  userId,
  lang = "en",
  page = 1,
  limit = 20,
  isRead,
}) {
  const filter = { user: userId };

  // Optional filter by read status
  if (isRead === true || isRead === "true") {
    filter.isRead = true;
  } else if (isRead === false || isRead === "false") {
    filter.isRead = false;
  }

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 20);

  const [notifications, totalCount] = await Promise.all([
    InAppNotificationModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    InAppNotificationModel.countDocuments(filter),
  ]);

  return {
    totalPages: Math.ceil(totalCount / limitNum) || 1,
    page: pageNum,
    results: notifications.length,
    data: notifications.map((n) => mapNotificationToResponse(n, lang)),
  };
}

/**
 * Get unread count for a user
 */
export async function getUnreadCountService(userId) {
  const count = await InAppNotificationModel.countDocuments({
    user: userId,
    isRead: false,
  });

  return { unreadCount: count };
}

/**
 * Mark a single notification as read
 */
export async function markNotificationAsReadService({ userId, notificationId }) {
  const notification = await InAppNotificationModel.findOneAndUpdate(
    { _id: notificationId, user: userId },
    { isRead: true, readAt: new Date() },
    { new: true }
  );

  return notification ? { success: true } : { success: false };
}

/**
 * Mark all notifications as read for a user
 */
export async function markAllNotificationsAsReadService(userId) {
  const result = await InAppNotificationModel.updateMany(
    { user: userId, isRead: false },
    { isRead: true, readAt: new Date() }
  );

  return { modifiedCount: result.modifiedCount };
}

/**
 * Delete a single notification
 */
export async function deleteNotificationService({ userId, notificationId }) {
  const result = await InAppNotificationModel.deleteOne({
    _id: notificationId,
    user: userId,
  });

  return { deleted: result.deletedCount > 0 };
}

/**
 * Delete expired notifications (for cron job)
 */
export async function deleteExpiredNotificationsService() {
  const now = new Date();
  const result = await InAppNotificationModel.deleteMany({
    expiresAt: { $lte: now },
  });

  return { deletedCount: result.deletedCount };
}
