import mongoose from "mongoose";
import { notificationOutboxStatusEnum } from "../../shared/constants/enums.js";

const { Schema, model } = mongoose;

// Backwards-compatible local alias for callers that imported the initial model
// constant before the shared enum set was introduced.
export const notificationOutboxStatus = notificationOutboxStatusEnum;

const notificationOutboxSchema = new Schema(
  {
    // A deterministic per-recipient/event key. It is the durable dedupe
    // boundary and must never contain an FCM token or sensitive payload data.
    dedupeKey: { type: String, required: true, trim: true, unique: true },

    recipientUser: { type: Schema.Types.ObjectId, ref: "User", index: true },
    recipientGuestId: { type: String, trim: true, index: true },

    // Safe notification display data only. Provider tokens, proof URLs,
    // payment secrets, and raw provider payloads do not belong in this model.
    title_en: { type: String, required: true },
    title_ar: { type: String },
    body_en: { type: String, required: true },
    body_ar: { type: String },
    icon: { type: String, default: "system" },
    action: {
      type: { type: String },
      screen: { type: String },
      params: { type: Schema.Types.Mixed },
    },
    source: {
      domain: { type: String },
      event: { type: String },
      referenceId: { type: String },
    },

    status: {
      type: String,
      enum: Object.values(notificationOutboxStatusEnum),
      default: notificationOutboxStatusEnum.PENDING,
      index: true,
    },
    attempts: { type: Number, default: 0, min: 0 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    leaseToken: { type: String, select: false },
    leaseExpiresAt: { type: Date, index: true },
    lastErrorCode: { type: String, maxlength: 80 },
    lastErrorMessage: { type: String, maxlength: 512 },
    sentAt: { type: Date },
    deadLetteredAt: { type: Date },
  },
  { timestamps: true },
);

notificationOutboxSchema.pre("validate", function validateRecipient() {
  const hasUser = Boolean(this.recipientUser);
  const hasGuest =
    typeof this.recipientGuestId === "string" && this.recipientGuestId.trim();

  if (hasUser === Boolean(hasGuest)) {
    this.invalidate(
      "recipientUser",
      "Exactly one outbox recipient (recipientUser or recipientGuestId) is required",
    );
  }
});

notificationOutboxSchema.index({ status: 1, nextAttemptAt: 1 });
notificationOutboxSchema.index({ status: 1, leaseExpiresAt: 1 });
notificationOutboxSchema.index({ recipientUser: 1, createdAt: -1 });
notificationOutboxSchema.index({ recipientGuestId: 1, createdAt: -1 });

export const NotificationOutboxModel = model(
  "NotificationOutbox",
  notificationOutboxSchema,
);
