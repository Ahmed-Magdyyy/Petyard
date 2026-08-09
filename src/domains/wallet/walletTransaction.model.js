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
    // Additive piastre representation for new settlement operations. Legacy
    // decimal `amount` remains required until historical writers are migrated.
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
      enum: [
        "ORDER_DEBIT",
        "ORDER_REFUND",
        "ORDER_CARD_REFUND",
        "SUBSTITUTION_DEBIT",
        "SUBSTITUTION_CREDIT",
        "POINTS_REDEEM_CREDIT",
        "ADMIN_ADJUST",
      ],
      required: true,
      index: true,
    },
    referenceType: {
      type: String,
      enum: ["ORDER", "SUBSTITUTION", "LOYALTY_REDEMPTION", "ADMIN"],
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
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    description_en: {
      type: String,
      trim: true,
    },
    description_ar: {
      type: String,
      trim: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

walletTransactionSchema.index({ user: 1, createdAt: -1 });
walletTransactionSchema.index(
  { type: 1, referenceType: 1, referenceId: 1 },
  { unique: true },
);
walletTransactionSchema.index(
  { operationId: 1 },
  {
    unique: true,
    partialFilterExpression: { operationId: { $type: 'string' } },
  },
);

export const WalletTransactionModel = model(
  "WalletTransaction",
  walletTransactionSchema,
);
