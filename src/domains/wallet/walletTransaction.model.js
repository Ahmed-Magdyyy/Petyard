import mongoose from "mongoose";

const { Schema, model } = mongoose;

const walletTransactionSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    type: {
      type: String,
      enum: ["ORDER_DEBIT", "ORDER_REFUND", "POINTS_REDEEM_CREDIT", "ADMIN_ADJUST"],
      required: true,
      index: true,
    },
    referenceType: {
      type: String,
      enum: ["ORDER", "LOYALTY_REDEMPTION", "ADMIN"],
      required: true,
    },
    referenceId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    balanceAfter: {
      type: Number,
      required: true,
    },
    note: {
      type: String,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

walletTransactionSchema.index({ user: 1, createdAt: -1 });
walletTransactionSchema.index({ type: 1, referenceType: 1, referenceId: 1 }, { unique: true });

export const WalletTransactionModel = model("WalletTransaction", walletTransactionSchema);
