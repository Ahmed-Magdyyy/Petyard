import { UserModel } from "../../user/user.model.js";
import mongoose from "mongoose";
import { NotificationOutboxModel } from "../../notification/notificationOutbox.model.js";
import { enqueueNotificationOutbox, findNotificationOutboxByDedupeKey } from "../../notification/notificationOutbox.service.js";
import { accountStatus, roles, enabledControls, serviceReservationStatusEnum } from "../../../shared/constants/enums.js";
import { AssistantBookingReceipt } from "../shared/assistant.booking-receipt.model.js";
import { requireEnabled } from "../shared/assistant.config.js";
import { transaction } from "../shared/assistant.store.js";
import { reject } from "../shared/assistant.errors.js";
import { objectId } from "../shared/assistant.validation.js";
import { bookingReceiptDto } from "../shared/assistant.booking-receipt.integrity.js";

async function ready() {
  let receipts, outbox;
  try { receipts = await AssistantBookingReceipt.collection.indexes(); outbox = await NotificationOutboxModel.collection.indexes(); }
  catch { reject("booking_notification_store_unavailable", 503); }
  if (!receipts.some(entry => entry.name === "_id_" && JSON.stringify(entry.key) === '{"_id":1}' && !entry.partialFilterExpression && !entry.sparse && (!entry.collation || entry.collation.locale === "simple")) ||
    !receipts.some(entry => JSON.stringify(entry.key) === '{"notificationPending":1,"notificationAttemptedAt":1,"recordedAt":1,"_id":1}' && !entry.hidden && !entry.partialFilterExpression && !entry.sparse && (!entry.collation || entry.collation.locale === "simple")) ||
    !outbox.some(entry => JSON.stringify(entry.key) === '{"dedupeKey":1}' && entry.unique === true && !entry.partialFilterExpression && !entry.sparse && (!entry.collation || entry.collation.locale === "simple")) ||
    [...receipts, ...outbox].some(entry => entry.expireAfterSeconds !== undefined)) reject("booking_notification_store_unavailable", 503);
}
async function enqueueReceipt(id) {
  return transaction(async session => {
    const row = await AssistantBookingReceipt.findOne({ _id: id, notificationPending: true }).maxTimeMS(5000).session(session).lean();
    if (!row) return { completed: false, deferred: false, queued: 0 };
    const receipt = bookingReceiptDto(row), owner = objectId(String(row.owner));
    const ids = receipt.result.services.map(service => objectId(service.reservationId));
    // Native reads avoid registering the ordinary booking model in the background worker.
    const reservations = await mongoose.connection.db.collection("servicereservations")
      .find({ _id: { $in: ids }, user: owner }, { projection: { _id: 1, status: 1 }, limit: 13, maxTimeMS: 5000, session }).toArray();
    if (reservations.length !== ids.length || reservations.some(row => !Object.values(serviceReservationStatusEnum).includes(row.status))) reject("booking_notification_reservation_unavailable", 503);
    const active = reservations.filter(row => [serviceReservationStatusEnum.BOOKED, serviceReservationStatusEnum.IN_PROGRESS].includes(row.status));
    let recipients = [];
    if (active.length) {
      recipients = await UserModel.find({ active: true, deletedAt: null, account_status: { $nin: [accountStatus.BANNED, accountStatus.DELETED] },
        $or: [{ role: roles.SUPER_ADMIN }, { role: roles.ADMIN, enabledControls: enabledControls.SERVICE_RESERVATIONS }] })
        .select("_id").sort({ _id: 1 }).limit(101).maxTimeMS(5000).session(session).lean();
      if (recipients.length > 100 || recipients.length * active.length > 100) reject("booking_notification_recipients_overflow", 503);
      if (!recipients.length) return { completed: false, deferred: true, queued: 0 };
    }
    // This real write serializes drainers; any outbox failure rolls it back with all queued rows.
    const claimed = await AssistantBookingReceipt.updateOne({ _id: id, owner, notificationPending: true, resultHash: row.resultHash, requestHash: row.requestHash },
      { $set: { notificationPending: false, notificationQueuedAt: new Date() } }, { session });
    if (claimed.matchedCount !== 1 || claimed.modifiedCount !== 1) return { completed: false, deferred: false, queued: 0 };
    let queued = 0;
    for (const reservation of active) for (const recipient of recipients) {
      const reservationId = String(reservation._id), recipientId = String(recipient._id);
      const dedupeKey = `assistant:booking_created:${reservationId}:${recipientId}`;
      const existing = await findNotificationOutboxByDedupeKey({ dedupeKey, session });
      if (existing) {
        if (String(existing.recipientUser) !== recipientId || existing.source?.domain !== "assistant" || existing.source?.event !== "booking_created" ||
          existing.source?.referenceId !== reservationId || existing.action?.params?.reservationId !== reservationId) reject("booking_notification_outbox_conflict", 503);
        continue;
      }
      await enqueueNotificationOutbox({ recipientUser: recipient._id, dedupeKey, session, title_en: "New Service Reservation", title_ar: "حجز خدمة جديد",
        body_en: "A new service reservation is ready to review.", body_ar: "في حجز خدمة جديد محتاج مراجعة.", icon: "service",
        action: { type: "service_reservation_detail", screen: "ServiceReservationDetailScreen", params: { reservationId } },
        source: { domain: "assistant", event: "booking_created", referenceId: reservationId } });
      queued++;
    }
    return { completed: true, deferred: false, queued };
  });
}

export async function drainBookingNotifications(config) {
  if (config.enabled !== true || config.bookingNotificationsEnabled !== true) return { enabled: false, processed: 0, queued: 0, deferred: 0, failed: 0 };
  requireEnabled(config); await ready();
  const candidates = await AssistantBookingReceipt.find({ notificationPending: true }).select("_id").sort({ notificationAttemptedAt: 1, recordedAt: 1, _id: 1 }).limit(25).maxTimeMS(5000).lean();
  const result = { enabled: true, processed: 0, queued: 0, deferred: 0, failed: 0 };
  for (const row of candidates) {
    try {
      // Rotate failed/deferred work so an old corrupt batch cannot starve later bookings.
      const attempt = await AssistantBookingReceipt.updateOne({ _id: row._id, notificationPending: true }, { $set: { notificationAttemptedAt: new Date() } });
      if (attempt.matchedCount !== 1) continue;
      const current = await enqueueReceipt(row._id); result.processed += Number(current.completed); result.deferred += Number(current.deferred); result.queued += current.queued;
    }
    catch { result.failed++; }
  }
  return result;
}
