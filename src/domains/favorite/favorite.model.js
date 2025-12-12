import mongoose from "mongoose";

const { Schema, model } = mongoose;

const favoriteItemSchema = new Schema(
  {
    product: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    productName: {
      type: String,
      required: true,
    },
    productImageUrl: {
      type: String,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    discountedPrice: {
      type: Number,
      min: 0,
    },
    addedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const favoriteSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    guestId: {
      type: String,
      index: true,
    },
    items: {
      type: [favoriteItemSchema],
      default: [],
    },
  },
  { timestamps: true }
);

favoriteSchema.index({ user: 1 });
favoriteSchema.index({ guestId: 1 });

export const FavoriteModel = model("Favorite", favoriteSchema);
