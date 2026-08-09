import mongoose from "mongoose";
import {
  refundOperationStatusEnum,
} from "../../shared/constants/enums.js";

const { Schema, model } = mongoose;

const refundOperationSchema = new Schema(
  {
    operationId: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      maxlength: 128,
    },
    order: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    substitutionRequest: {
      type: Schema.Types.ObjectId,
      ref: "SubstitutionRequest",
      required: true,
      index: true,
    },
    paymentAttempt: {
      type: Schema.Types.ObjectId,
      ref: "OrderPaymentAttempt",
    },
    user: { type: Schema.Types.ObjectId, ref: "User" },
    guestId: { type: String, trim: true },
    method: {
      type: String,
      enum: ["card", "manual", "wallet"],
      required: true,
    },
    amountPiastres: { type: Number, required: true, min: 1 },
    currency: {
      type: String,
      required: true,
      default: "EGP",
      uppercase: true,
      trim: true,
      maxlength: 3,
    },
    originalTransactionId: { type: String, trim: true, maxlength: 128 },
    providerRefundTransactionId: { type: String, trim: true, maxlength: 128 },
    // Written immediately after the gateway accepts a refund and before local
    // settlement finalization. A retried worker must finalize from this marker
    // instead of calling the gateway a second time.
    providerRefundSucceededAt: { type: Date },
    status: {
      type: String,
      enum: Object.values(refundOperationStatusEnum),
      default: refundOperationStatusEnum.PENDING,
      required: true,
    },
    attempts: { type: Number, min: 0, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    leaseToken: { type: String, trim: true, maxlength: 80 },
    leaseExpiresAt: { type: Date },
    completedAt: { type: Date },
    errorCode: { type: String, trim: true, maxlength: 80 },
    errorAt: { type: Date },
  },
  { timestamps: true },
);

refundOperationSchema.pre("validate", function validateOwner() {
  const hasUser = Boolean(this.user);
  const hasGuest = Boolean(this.guestId);
  if (hasUser === hasGuest) {
    this.invalidate("user", "Exactly one of user or guestId is required");
    this.invalidate("guestId", "Exactly one of user or guestId is required");
  }
});

refundOperationSchema.index({ status: 1, nextAttemptAt: 1 });
refundOperationSchema.index({ status: 1, leaseExpiresAt: 1 });
refundOperationSchema.index({ substitutionRequest: 1, createdAt: -1 });
refundOperationSchema.index({ user: 1, createdAt: -1 });
refundOperationSchema.index({ guestId: 1, createdAt: -1 });

export const RefundOperationModel = model("RefundOperation", refundOperationSchema);
