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
    // Recipient (required for in-app)
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
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
      enum: ["order", "promo", "appointment", "product", "pet", "wallet", "loyalty", "system"],
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
  },
  { timestamps: true }
);

// Compound indexes for efficient user notification queries
inAppNotificationSchema.index({ user: 1, createdAt: -1 });
inAppNotificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });

export const InAppNotificationModel = model(
  "InAppNotification",
  inAppNotificationSchema
);
