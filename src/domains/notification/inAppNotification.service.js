import { InAppNotificationModel } from "./inAppNotification.model.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import { buildPagination } from "../../shared/utils/apiFeatures.js";
import { parseBoundedInt } from "../../shared/utils/env.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { roles } from "../../shared/constants/enums.js";

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
}

const BULK_INSERT_CHUNK_SIZE = parseBoundedInt(
  process.env.IN_APP_NOTIFICATION_INSERT_CHUNK_SIZE,
  1000,
  100,
  5000,
);

function getActorFilter({ userId, guestId }) {
  const hasUser = Boolean(userId);
  const normalizedGuestId =
    typeof guestId === "string" ? guestId.trim() : "";
  const hasGuest = Boolean(normalizedGuestId);

  if (hasUser === hasGuest) {
    throw new ApiError("Exactly one notification recipient is required", 400);
  }

  return hasUser ? { user: userId } : { guestId: normalizedGuestId };
}

function getVisibleActorFilter({ userId, guestId, actorRole }) {
  const filter = getActorFilter({ userId, guestId });
  if (!userId || actorRole !== roles.SUPER_ADMIN) {
    filter.$nor = [{ "source.domain": "assistant", "source.event": "review_candidate" }];
  }
  return filter;
}

function buildNotificationDocument({
  userId,
  guestId,
  title_en,
  title_ar,
  body_en,
  body_ar,
  icon = "system",
  action,
  source,
  expiresAt,
  dedupeKey,
}) {
  return {
    ...getActorFilter({ userId, guestId }),
    title_en,
    title_ar: title_ar || title_en,
    body_en,
    body_ar: body_ar || body_en,
    icon,
    action: action || {},
    source: source || {},
    expiresAt,
    ...(typeof dedupeKey === "string" && dedupeKey.trim()
      ? { dedupeKey: dedupeKey.trim() }
      : {}),
  };
}

/**
 * Create a new in-app notification for either a user or a guest. A dedupe key
 * makes the insert idempotent, and a supplied session keeps it transactional.
 */
export async function createInAppNotificationService({
  userId,
  guestId,
  session,
  ...notificationFields
}) {
  // Preserve the existing user-only no-op behaviour used by the dispatcher.
  if (!userId && !guestId) return null;

  const doc = buildNotificationDocument({
    userId,
    guestId,
    ...notificationFields,
  });

  if (doc.dedupeKey) {
    return InAppNotificationModel.findOneAndUpdate(
      { dedupeKey: doc.dedupeKey },
      { $setOnInsert: doc },
      {
        returnDocument: "after",
        upsert: true,
        setDefaultsOnInsert: true,
        ...(session ? { session } : {}),
      },
    );
  }

  const created = await InAppNotificationModel.create(
    [doc],
    session ? { session } : undefined,
  );
  return created[0];
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
  session,
}) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return { insertedCount: 0 };
  }

  let insertedCount = 0;

  for (let start = 0; start < userIds.length; start += BULK_INSERT_CHUNK_SIZE) {
    const docs = userIds.slice(start, start + BULK_INSERT_CHUNK_SIZE).map((userId) =>
      buildNotificationDocument({
        userId,
        title_en,
        title_ar,
        body_en,
        body_ar,
        icon,
        action,
        source,
        expiresAt,
      }),
    );

    const result = await InAppNotificationModel.insertMany(docs, {
      ordered: false,
      ...(session ? { session } : {}),
    });

    insertedCount += result.length;
  }

  return { insertedCount };
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
    source: notification.source || null,
    isRead: notification.isRead || false,
    createdAt: notification.createdAt,
  };
}

/**
 * Get paginated notifications for a user
 * Returns format: { totalPages, page, results, data }
 */
export async function getNotificationsForActorService({
  userId,
  guestId,
  actorRole,
  lang = "en",
  page = 1,
  limit = 20,
  isRead,
}) {
  const filter = getVisibleActorFilter({ userId, guestId, actorRole });

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
export async function getUnreadCountForActorService({ userId, guestId, actorRole }) {
  const count = await InAppNotificationModel.countDocuments({
    ...getVisibleActorFilter({ userId, guestId, actorRole }),
    isRead: false,
  });

  return { unreadCount: count };
}

/**
 * Mark a single notification as read
 */
export async function markNotificationAsReadForActorService({
  userId,
  guestId,
  actorRole,
  notificationId,
}) {
  const notification = await InAppNotificationModel.findOneAndUpdate(
    { _id: notificationId, ...getVisibleActorFilter({ userId, guestId, actorRole }) },
    { isRead: true, readAt: new Date() },
    { returnDocument: "after" }
  );

  return notification ? { success: true } : { success: false };
}

/**
 * Mark all notifications as read for a user
 */
export async function markAllNotificationsAsReadForActorService({ userId, guestId, actorRole }) {
  const result = await InAppNotificationModel.updateMany(
    { ...getVisibleActorFilter({ userId, guestId, actorRole }), isRead: false },
    { isRead: true, readAt: new Date() }
  );

  return { modifiedCount: result.modifiedCount };
}

/**
 * Delete a single notification
 */
export async function deleteNotificationForActorService({
  userId,
  guestId,
  actorRole,
  notificationId,
}) {
  const result = await InAppNotificationModel.deleteOne({
    _id: notificationId,
    ...getVisibleActorFilter({ userId, guestId, actorRole }),
  });

  return { deleted: result.deletedCount > 0 };
}

// Legacy registered-user exports.
export const getMyNotificationsService = ({ userId, ...rest }) =>
  getNotificationsForActorService({ userId, ...rest });
export const getUnreadCountService = (userId, actorRole) =>
  getUnreadCountForActorService({ userId, actorRole });
export const markNotificationAsReadService = ({ userId, notificationId, actorRole }) =>
  markNotificationAsReadForActorService({ userId, notificationId, actorRole });
export const markAllNotificationsAsReadService = (userId, actorRole) =>
  markAllNotificationsAsReadForActorService({ userId, actorRole });
export const deleteNotificationService = ({ userId, notificationId, actorRole }) =>
  deleteNotificationForActorService({ userId, notificationId, actorRole });

// Guest-specific exports keep every query and mutation owner scoped.
export const getGuestNotificationsService = ({ guestId, ...rest }) =>
  getNotificationsForActorService({ guestId, ...rest });
export const getGuestUnreadCountService = (guestId) =>
  getUnreadCountForActorService({ guestId });
export const markGuestNotificationAsReadService = ({ guestId, notificationId }) =>
  markNotificationAsReadForActorService({ guestId, notificationId });
export const markAllGuestNotificationsAsReadService = (guestId) =>
  markAllNotificationsAsReadForActorService({ guestId });
export const deleteGuestNotificationService = ({ guestId, notificationId }) =>
  deleteNotificationForActorService({ guestId, notificationId });

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
