import mongoose from "mongoose";
import { bundleCartGroupSchema } from "../bundle/bundle.cart-schema.js";
import { assertOrdinaryCart, ordinaryCartFilter } from "./cart.bundle-compatibility.js";
import {
  cartStatusEnum,
  productTypeEnum,
} from "../../shared/constants/enums.js";

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
      enum: Object.values(productTypeEnum),
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
        _id: false,
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
  },
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

    bundles: {
      type: [bundleCartGroupSchema],
      default: undefined,
      validate: rows => rows === undefined || (Array.isArray(rows) &&
        new Set(rows.map(row => row.id)).size === rows.length &&
        new Set(rows.map(row => row.bundleId)).size === rows.length),
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

    deliveryAddress: {
      // Geographic zone; cart.warehouse remains the fulfillment warehouse.
      warehouse: { type: Schema.Types.ObjectId, ref: "Warehouse" },
      userAddressId: {
        type: Schema.Types.ObjectId,
      },
      guestAddressId: {
        type: Schema.Types.ObjectId,
      },
      label: String,
      name: String,
      governorate: String,
      area: String,
      phone: String,
      building: String,
      floor: String,
      apartment: String,
      location: {
        lat: Number,
        lng: Number,
      },
      details: String,
    },

    checkoutKey: {
      type: String,
      index: true,
    },

    status: {
      type: String,
      enum: Object.values(cartStatusEnum),
      default: cartStatusEnum.ACTIVE,
      index: true,
    },

    lastActivityAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    abandonedAt: {
      type: Date,
    },

    abandonedEmailSentAt: {
      type: Date,
    },

    abandonedEmailCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

cartSchema.index({ user: 1 });
cartSchema.index({ status: 1, lastActivityAt: 1 });

// Legacy saves must not prune/reprice groups, even if a bundle writer won after the read.
cartSchema.pre("save", function () {
  assertOrdinaryCart(this);
  if (!this.isNew) this.$where = ordinaryCartFilter(this.$where ?? {});
});
for (const operation of ["updateOne", "updateMany", "deleteOne", "deleteMany", "findOneAndUpdate", "findOneAndDelete", "replaceOne", "findOneAndReplace"]) {
  cartSchema.pre(operation, { query: true, document: false }, function () {
    this.setQuery(ordinaryCartFilter(this.getFilter()));
  });
}

export const CartModel = model("Cart", cartSchema);
