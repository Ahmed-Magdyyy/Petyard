import mongoose from "mongoose";

const { Schema, model } = mongoose;

const loyaltyTransactionSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    points: {
      type: Number,
      required: true,
    },
    // Loyalty remains point-based, but settlement callers use the same
    // deterministic operation boundary as wallet and payment operations.
    amountPiastres: {
      type: Number,
      min: 0,
    },
    currency: {
      type: String,
      trim: true,
      uppercase: true,
      default: 'EGP',
    },
    operationId: {
      type: String,
      trim: true,
    },
    type: {
      type: String,
      enum: ["EARNED", "REDEEMED", "DEDUCTED", "ADMIN_ADJUST"],
      required: true,
      index: true,
    },
    referenceType: {
      type: String,
      enum: ["ORDER", "REDEMPTION", "ADMIN"],
      required: true,
    },
    referenceId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    balanceAfter: {
      type: Number,
      required: true,
      min: 0,
    },
    description_en: {
      type: String,
      trim: true,
    },
    description_ar: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

loyaltyTransactionSchema.index({ user: 1, createdAt: -1 });
loyaltyTransactionSchema.index({ type: 1, createdAt: -1 });
loyaltyTransactionSchema.index(
  { operationId: 1 },
  {
    unique: true,
    partialFilterExpression: { operationId: { $type: 'string' } },
  },
);

export const LoyaltyTransactionModel = model("LoyaltyTransaction", loyaltyTransactionSchema);
