import mongoose from "mongoose";
import {
  orderPaymentAttemptStatusEnum,
} from "../../shared/constants/enums.js";

const { Schema, model } = mongoose;

const orderPaymentAttemptSchema = new Schema(
  {
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
    user: { type: Schema.Types.ObjectId, ref: "User" },
    guestId: { type: String, trim: true },
    requestIdempotencyKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    merchantOrderId: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      maxlength: 96,
    },
    attemptNumber: { type: Number, required: true, min: 1, default: 1 },
    amountPiastres: { type: Number, required: true, min: 1 },
    currency: {
      type: String,
      required: true,
      default: "EGP",
      uppercase: true,
      trim: true,
      maxlength: 3,
    },
    status: {
      type: String,
      enum: Object.values(orderPaymentAttemptStatusEnum),
      required: true,
      default: orderPaymentAttemptStatusEnum.INITIALIZING,
    },
    // This immutable acceptance marker supports a partial unique index even
    // when a successful attempt later transitions to refunded.
    successAccepted: { type: Boolean, required: true, default: false },
    expiresAt: { type: Date, required: true },
    paymobIntentionId: { type: String, trim: true, maxlength: 128 },
    paymobOrderId: { type: String, trim: true, maxlength: 128 },
    paymobTransactionId: { type: String, trim: true, maxlength: 128 },
    initializationLeaseToken: { type: String, trim: true, maxlength: 80 },
    initializationLeaseExpiresAt: { type: Date },
    initializedAt: { type: Date },
    succeededAt: { type: Date },
    failedAt: { type: Date },
    supersededAt: { type: Date },
    expiredAt: { type: Date },
    lateSuccessAt: { type: Date },
    refundedAt: { type: Date },
    // Durable link to the refund operation for a late accepted top-up. It lets
    // the reconciler skip already-materialized work after a webhook crash.
    refundOperation: {
      type: Schema.Types.ObjectId,
      ref: "RefundOperation",
    },
    errorCode: { type: String, trim: true, maxlength: 80 },
    errorAt: { type: Date },
  },
  { timestamps: true },
);

orderPaymentAttemptSchema.pre("validate", function validateOwner() {
  const hasUser = Boolean(this.user);
  const hasGuest = Boolean(this.guestId);
  if (hasUser === hasGuest) {
    this.invalidate("user", "Exactly one of user or guestId is required");
    this.invalidate("guestId", "Exactly one of user or guestId is required");
  }
});

orderPaymentAttemptSchema.index(
  { substitutionRequest: 1, requestIdempotencyKey: 1 },
  { unique: true },
);
orderPaymentAttemptSchema.index({ paymobOrderId: 1 }, { sparse: true, unique: true });
orderPaymentAttemptSchema.index(
  { substitutionRequest: 1, successAccepted: 1 },
  {
    unique: true,
    partialFilterExpression: { successAccepted: true },
  },
);
orderPaymentAttemptSchema.index({ substitutionRequest: 1, status: 1, expiresAt: 1 });
orderPaymentAttemptSchema.index({
  status: 1,
  refundOperation: 1,
  lateSuccessAt: 1,
});
orderPaymentAttemptSchema.index({ user: 1, createdAt: -1 });
orderPaymentAttemptSchema.index({ guestId: 1, createdAt: -1 });

export const OrderPaymentAttemptModel = model(
  "OrderPaymentAttempt",
  orderPaymentAttemptSchema,
);
