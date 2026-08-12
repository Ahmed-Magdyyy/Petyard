import mongoose from "mongoose";

const { Schema, model } = mongoose;

const subcategorySubscriptionSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: undefined,
    },
    // Guests are identified consistently with carts, favorites, orders, and
    // notification devices. A subscription belongs to either this guest ID or
    // a registered user, never both.
    guestId: {
      type: String,
      trim: true,
      default: undefined,
    },
    subcategory: {
      type: Schema.Types.ObjectId,
      ref: "Subcategory",
      required: true,
    },
    // This records the most recent demand location without changing the
    // existing one-row-per-owner-and-subcategory uniqueness contract.
    warehouse: {
      type: Schema.Types.ObjectId,
      ref: 'Warehouse',
      default: null,
    },
  },
  { timestamps: true },
);

subcategorySubscriptionSchema.pre("validate", function validateOwner() {
  const hasUser = Boolean(this.user);
  const hasGuest = typeof this.guestId === "string" && this.guestId.trim().length > 0;

  if (hasUser === hasGuest) {
    throw new Error(
      "A subcategory subscription must belong to exactly one of user or guestId",
    );
  }
});

// A user or a guest can follow an exact subcategory once. Partial indexes keep
// legacy user rows valid while enforcing uniqueness for each owner type.
subcategorySubscriptionSchema.index(
  { user: 1, subcategory: 1 },
  {
    unique: true,
    partialFilterExpression: { user: { $type: "objectId" } },
  },
);
subcategorySubscriptionSchema.index(
  { guestId: 1, subcategory: 1 },
  {
    unique: true,
    partialFilterExpression: { guestId: { $type: "string" } },
  },
);
subcategorySubscriptionSchema.index({ subcategory: 1, user: 1 });
subcategorySubscriptionSchema.index({ subcategory: 1, guestId: 1 });
subcategorySubscriptionSchema.index({ subcategory: 1, warehouse: 1 });
subcategorySubscriptionSchema.index({ warehouse: 1, createdAt: -1 });

export const SubcategorySubscriptionModel = model(
  "SubcategorySubscription",
  subcategorySubscriptionSchema,
);
