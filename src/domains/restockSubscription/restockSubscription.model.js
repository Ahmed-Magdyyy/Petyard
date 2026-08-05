import mongoose from "mongoose";

const { Schema, model } = mongoose;

export const restockSubscriptionStatus = Object.freeze({
  ACTIVE: "ACTIVE",
  PROCESSING: "PROCESSING",
  NOTIFIED: "NOTIFIED",
  CANCELLED: "CANCELLED",
});

const restockSubscriptionSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    // Guest identities are supplied by the client in x-guest-id, matching the
    // existing cart, favorites, orders, and notification-device conventions.
    guestId: {
      type: String,
      trim: true,
    },
    product: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    warehouse: {
      type: Schema.Types.ObjectId,
      ref: "Warehouse",
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(restockSubscriptionStatus),
      default: restockSubscriptionStatus.ACTIVE,
      required: true,
    },
    claimToken: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    notifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// A subscription belongs to exactly one identity. Keeping this check at the
// schema level protects writes outside the service layer as well.
restockSubscriptionSchema.pre("validate", function validateOwner() {
  const hasUser = Boolean(this.user);
  const guestId = typeof this.guestId === "string" ? this.guestId.trim() : "";
  const hasGuest = Boolean(guestId);

  if (hasGuest) this.guestId = guestId;

  if (hasUser === hasGuest) {
    throw new Error(
      "A restock subscription must belong to exactly one user or guest",
    );
  }
});

// Keep one durable row per identity/product/warehouse. Partial indexes allow
// user and guest rows to coexist for the same product and warehouse.
//
// Deployment note: the former non-partial user/product/warehouse unique index
// must be replaced by this partial index in existing production databases.
restockSubscriptionSchema.index(
  { user: 1, product: 1, warehouse: 1 },
  {
    name: "restock_unique_user_product_warehouse",
    unique: true,
    partialFilterExpression: { user: { $type: "objectId" } },
  }
);
restockSubscriptionSchema.index(
  { guestId: 1, product: 1, warehouse: 1 },
  {
    name: "restock_unique_guest_product_warehouse",
    unique: true,
    partialFilterExpression: { guestId: { $type: "string" } },
  }
);
restockSubscriptionSchema.index({ product: 1, warehouse: 1, status: 1 });
restockSubscriptionSchema.index({ status: 1, claimedAt: 1 });

export const RestockSubscriptionModel = model(
  "RestockSubscription",
  restockSubscriptionSchema
);
