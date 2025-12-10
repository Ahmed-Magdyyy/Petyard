import mongoose from "mongoose";

const { Schema, model } = mongoose;

const couponSchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },

    discountType: {
      type: String,
      enum: ["PERCENT", "FIXED"],
    },

    discountValue: {
      type: Number,
      min: 0,
    },

    maxDiscountAmount: {
      type: Number,
      min: 0,
    },

    freeShipping: {
      type: Boolean,
      default: false,
    },

    minOrderTotal: {
      type: Number,
      min: 0,
    },

    maxOrderTotal: {
      type: Number,
      min: 0,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    startsAt: {
      type: Date,
    },

    expiresAt: {
      type: Date,
      index: true,
    },

    maxUsageTotal: {
      type: Number,
      min: 0,
    },

    maxUsagePerUser: {
      type: Number,
      min: 0,
      default: 1
    },

    usageCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    firstOrderOnly: {
      type: Boolean,
      default: false,
    },

    allowedUserIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  { timestamps: true }
);

couponSchema.index({ isActive: 1, startsAt: 1, expiresAt: 1 });

export const CouponModel = model("Coupon", couponSchema);
