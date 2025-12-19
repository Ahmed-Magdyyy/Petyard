import mongoose from "mongoose";
import {
  orderStatusEnum,
  paymentMethodEnum,
  paymentStatusEnum
} from "../../shared/constants/enums.js";

const { Schema, model } = mongoose;

const orderItemSchema = new Schema(
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
    productName: { type: String, required: true },
    productImageUrl: { type: String },
    variantId: { type: Schema.Types.ObjectId },
    variantOptions: [
      {
        _id: false,
        name: { type: String, required: true, trim: true },
        value: { type: String, required: true, trim: true },
      },
    ],
    quantity: { type: Number, required: true, min: 1 },
    baseEffectivePrice: { type: Number, min: 0 },
    promotion: {
      collectionId: { type: Schema.Types.ObjectId, ref: "Collection" },
      collectionSlug: { type: String },
      discountPercent: { type: Number, min: 0, max: 100 },
    },
    promotionDiscountedPrice: { type: Number, min: 0 },
    itemPrice: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const historyEntrySchema = new Schema(
  {
    at: { type: Date, required: true, default: Date.now },
    description: { type: String, required: true, trim: true },
    byUserId: { type: Schema.Types.ObjectId, ref: "User" },
    visibleToUser: { type: Boolean, default: true },
  },
  {
    _id: false,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        const userVal = ret.byUserId;
        let byUser = null;

        if (userVal && typeof userVal === "object") {
          const id = userVal._id ? String(userVal._id) : undefined;
          const name = typeof userVal.name === "string" ? userVal.name : undefined;
          const role = userVal.role;
          byUser = {};
          if (id) byUser.id = id;
          if (name) byUser.name = name;
          if (role) byUser.role = role;
        } else if (userVal) {
          byUser = { id: String(userVal) };
        }

        if (byUser) {
          ret.byUser = byUser;
        }

        delete ret.byUserId;
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      transform(doc, ret) {
        const userVal = ret.byUserId;
        let byUser = null;

        if (userVal && typeof userVal === "object") {
          const id = userVal._id ? String(userVal._id) : undefined;
          const name = typeof userVal.name === "string" ? userVal.name : undefined;
          const role = userVal.role;
          byUser = {};
          if (id) byUser.id = id;
          if (name) byUser.name = name;
          if (role) byUser.role = role;
        } else if (userVal) {
          byUser = { id: String(userVal) };
        }

        if (byUser) {
          ret.byUser = byUser;
        }

        delete ret.byUserId;
        return ret;
      },
    },
  }
);

const orderSchema = new Schema(
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

    orderNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    currency: {
      type: String,
      default: "EGP",
    },
    deliveryAddress: {
      userAddressId: { type: Schema.Types.ObjectId },
      label: { type: String },
      name: { type: String },
      governorate: { type: String },
      area: { type: String },
      phone: { type: String },
      location: {
        lat: { type: Number },
        lng: { type: Number },
      },
      details: { type: String },
    },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "Order must contain at least one item",
      },
    },
    subtotal: { type: Number, required: true, min: 0 },
    shippingFee: { type: Number, required: true, min: 0 },
    discountAmount: { type: Number, required: true, min: 0, default: 0 },
    shippingDiscount: { type: Number, required: true, min: 0, default: 0 },
    totalDiscount: { type: Number, required: true, min: 0, default: 0 },
    walletUsed: { type: Number, required: true, min: 0, default: 0 },
    total: { type: Number, required: true, min: 0 },
    couponCode: { type: String },
    loyaltyPointsAwarded: { type: Number, min: 0, default: 0 },
    status: {
      type: String,
      enum: Object.values(orderStatusEnum),
      default: orderStatusEnum.PENDING,
      index: true,
    },
    paymentMethod: {
      type: String,
      enum: Object.values(paymentMethodEnum),
      default: paymentMethodEnum.COD,
    },
    paymentStatus: {
      type: String,
      enum: Object.values(paymentStatusEnum),
      default: paymentStatusEnum.PENDING,
    },
    history: {
      type: [historyEntrySchema],
      default: [],
    },
    notes: { type: String },
  },
  { timestamps: true }
);

orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ guestId: 1, createdAt: -1 });
orderSchema.index({ warehouse: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });

export const OrderModel = model("Order", orderSchema);
