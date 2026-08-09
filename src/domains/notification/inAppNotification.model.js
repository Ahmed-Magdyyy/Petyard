import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * In-App Notification Schema
 *
 * Stores persistent notifications for users to view in-app.
 * Supports i18n (title_en/ar, body_en/ar) and deep linking via action object.
 */
const inAppNotificationSchema = new Schema(
  {
    // Exactly one recipient is required. Guest notifications are intentionally
    // owned by the client-provided guest id; they are never shared with users.
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    guestId: {
      type: String,
      trim: true,
      index: true,
    },

    // Display content (i18n)
    title_en: {
      type: String,
      required: true,
    },
    title_ar: {
      type: String,
    },
    body_en: {
      type: String,
      required: true,
    },
    body_ar: {
      type: String,
    },

    // Visual icon type for FE to display appropriate icon
    icon: {
      type: String,
      enum: [
        "order",
        "promo",
        "appointment",
        "product",
        "pet",
        "wallet",
        "loyalty",
        "service",
        "system",
      ],
      default: "system",
    },

    // Navigation action for FE deep linking
    action: {
      type: {
        type: String,
        // e.g., "order_detail", "product_detail", "screen", "reservation_detail"
      },
      screen: {
        type: String,
        // e.g., "OrderDetailScreen", "OffersScreen", "WalletScreen"
      },
      params: {
        type: Schema.Types.Mixed,
        // e.g., { orderId: "...", productId: "..." }
      },
    },

    // Source tracking for debugging and analytics
    source: {
      domain: {
        type: String,
        // e.g., "order", "reservation", "wallet", "admin"
      },
      event: {
        type: String,
        // e.g., "status_changed", "created", "reminder", "promo"
      },
      referenceId: {
        type: String,
        // e.g., orderId, reservationId for linking back
      },
    },

    // Read status
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
    },

    // Optional expiry (notifications can be auto-deleted after this date)
    expiresAt: {
      type: Date,
      index: true,
    },

    // A stable, recipient-specific key used by the durable notification outbox
    // to make in-app delivery idempotent.
    dedupeKey: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true },
);

inAppNotificationSchema.pre("validate", function validateRecipient() {
  const hasUser = Boolean(this.user);
  const hasGuestId = typeof this.guestId === "string" && this.guestId.trim();

  if (hasUser === Boolean(hasGuestId)) {
    this.invalidate(
      "user",
      "Exactly one notification recipient (user or guestId) is required",
    );
  }
});

// Compound indexes for efficient user notification queries
inAppNotificationSchema.index({ user: 1, createdAt: -1 });
inAppNotificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });
inAppNotificationSchema.index({ guestId: 1, createdAt: -1 });
inAppNotificationSchema.index({ guestId: 1, isRead: 1, createdAt: -1 });
inAppNotificationSchema.index(
  { dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: "string" } },
  },
);

export const InAppNotificationModel = model(
  "InAppNotification",
  inAppNotificationSchema,
);
