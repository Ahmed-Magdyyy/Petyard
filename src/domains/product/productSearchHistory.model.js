import mongoose from "mongoose";

const { Schema, model } = mongoose;

const searchEntrySchema = new Schema(
  {
    q: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    normalized: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    searchedAt: {
      type: Date,
      required: true,
    },
  },
  { _id: false },
);

const productSearchHistorySchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: undefined,
    },
    guestId: {
      type: String,
      trim: true,
      default: undefined,
    },
    entries: {
      type: [searchEntrySchema],
      default: [],
      validate: {
        validator: (entries) => entries.length <= 10,
        message: "Search history cannot contain more than 10 entries",
      },
    },
  },
  { timestamps: true },
);

productSearchHistorySchema.pre("validate", function validateOwner() {
  const hasUser = Boolean(this.user);
  const guestId = typeof this.guestId === "string" ? this.guestId.trim() : "";
  const hasGuest = Boolean(guestId);

  if (hasGuest) this.guestId = guestId;

  if (hasUser === hasGuest) {
    throw new Error(
      "A product search history must belong to exactly one user or guest",
    );
  }
});

productSearchHistorySchema.index(
  { user: 1 },
  {
    name: "product_search_history_unique_user",
    unique: true,
    partialFilterExpression: { user: { $type: "objectId" } },
  },
);
productSearchHistorySchema.index(
  { guestId: 1 },
  {
    name: "product_search_history_unique_guest",
    unique: true,
    partialFilterExpression: { guestId: { $type: "string" } },
  },
);

export const ProductSearchHistoryModel = model(
  "ProductSearchHistory",
  productSearchHistorySchema,
);
