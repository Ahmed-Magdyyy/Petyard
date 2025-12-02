import mongoose from "mongoose";

const { Schema, model } = mongoose;

const cartItemSchema = new Schema(
  {
    product: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    productType: {
      type: String,
      enum: ["SIMPLE", "VARIANT"],
      required: true,
    },

    productName: {
      type: String,
    },

    productImageUrl: {
      type: String,
    },
    
    variantId: {
      type: Schema.Types.ObjectId,
    },

    variantOptionsSnapshot: [
      {
        name: { type: String, required: true, trim: true },
        value: { type: String, required: true, trim: true },
      },
    ],

    quantity: {
      type: Number,
      required: true,
      min: 1,
    },

    itemPrice: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  {
    _id: true,
  }
);

const cartSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },

    guestId: {
      type: String,
      index: true,
    },

    warehouse: {
      type: Schema.Types.ObjectId,
      ref: "Warehouse",
      required: true,
      index: true,
    },

    items: {
      type: [cartItemSchema],
      default: [],
    },

    totalCartPrice: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    currency: {
      type: String,
      default: "EGP",
    },
  },
  { timestamps: true }
);

cartSchema.index({ user: 1 });
cartSchema.index({ guestId: 1 });

export const CartModel = model("Cart", cartSchema);
