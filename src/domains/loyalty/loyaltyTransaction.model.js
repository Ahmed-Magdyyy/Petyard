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
    description: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

loyaltyTransactionSchema.index({ user: 1, createdAt: -1 });
loyaltyTransactionSchema.index({ type: 1, createdAt: -1 });

export const LoyaltyTransactionModel = model("LoyaltyTransaction", loyaltyTransactionSchema);
