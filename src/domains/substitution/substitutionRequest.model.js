import mongoose from "mongoose";
import {
  paymentMethodEnum,
  substitutionRequestStatusEnum,
} from "../../shared/constants/enums.js";
import { SUBSTITUTION_EXPIRY_PRESETS } from "./substitution.config.js";

const { Schema, model } = mongoose;

const variantOptionSnapshotSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    value: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const alternativeSchema = new Schema(
  {
    candidateId: { type: String, required: true, trim: true },
    product: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    variantId: { type: Schema.Types.ObjectId },
    productType: {
      type: String,
      enum: ["SIMPLE", "VARIANT"],
      required: true,
    },
    productName_en: { type: String, required: true, trim: true },
    productName_ar: { type: String, required: true, trim: true },
    productImageUrl: { type: String },
    variantOptions: { type: [variantOptionSnapshotSchema], default: [] },
    unitPricePiastres: { type: Number, required: true, min: 0 },
    maxQuantity: { type: Number, required: true, min: 1 },
    stockQuantitySnapshot: { type: Number, required: true, min: 0 },
    stockRevisionSnapshot: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const shortageSchema = new Schema(
  {
    shortageId: { type: String, required: true, trim: true },
    lineId: { type: String, required: true, trim: true },
    product: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    variantId: { type: Schema.Types.ObjectId },
    productType: {
      type: String,
      enum: ["SIMPLE", "VARIANT"],
      required: true,
    },
    productName_en: { type: String, required: true, trim: true },
    productName_ar: { type: String, required: true, trim: true },
    productImageUrl: { type: String },
    variantOptions: { type: [variantOptionSnapshotSchema], default: [] },
    quantityBefore: { type: Number, required: true, min: 1 },
    deliverableOriginalQuantity: { type: Number, required: true, min: 0 },
    unavailableQuantity: { type: Number, required: true, min: 1 },
    finalizedUnavailableStart: { type: Number, required: true, min: 0 },
    finalizedUnavailableEnd: { type: Number, required: true, min: 1 },
    originalUnitPricePiastres: { type: Number, required: true, min: 0 },
    expectedUnallocatedQuantity: { type: Number, required: true, min: 0 },
    expectedStockRevision: { type: Number, required: true, min: 0 },
    correctedUnallocatedQuantity: { type: Number, required: true, min: 0 },
    correctionReason: {
      type: String,
      enum: ["offline_sale"],
      default: "offline_sale",
    },
    correctionNote: { type: String, trim: true, maxlength: 500 },
    alternatives: { type: [alternativeSchema], default: [] },
  },
  { _id: false },
);

const choiceSchema = new Schema(
  {
    candidateId: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const selectionSchema = new Schema(
  {
    shortageId: { type: String, required: true, trim: true },
    choices: { type: [choiceSchema], default: [] },
    rejectedQuantity: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const reservedSkuSchema = new Schema(
  {
    product: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    variantId: { type: Schema.Types.ObjectId },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const pricingSnapshotSchema = new Schema(
  {
    previousOrderValuePiastres: { type: Number, required: true, min: 0 },
    finalMerchandiseGrossPiastres: { type: Number, required: true, min: 0 },
    preservedCouponDiscountPiastres: { type: Number, required: true, min: 0 },
    lockedNetShippingPiastres: { type: Number, required: true, min: 0 },
    newOrderValuePiastres: { type: Number, required: true, min: 0 },
    deltaPiastres: { type: Number, required: true },
    walletToUsePiastres: { type: Number, required: true, min: 0 },
    additionalPaymentPiastres: { type: Number, required: true, min: 0 },
    refundOrCreditPiastres: { type: Number, required: true, min: 0 },
    deliveryDuePiastres: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const lifecycleEntrySchema = new Schema(
  {
    at: { type: Date, default: Date.now, required: true },
    from: { type: String },
    to: { type: String, required: true },
    reason: { type: String, trim: true },
    actorType: {
      type: String,
      enum: ["staff", "user", "guest", "system", "payment_provider"],
      required: true,
    },
    actorUser: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { _id: false },
);

const substitutionRequestSchema = new Schema(
  {
    order: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    orderNumber: { type: String, required: true, trim: true },
    warehouse: {
      type: Schema.Types.ObjectId,
      ref: "Warehouse",
      required: true,
    },
    user: { type: Schema.Types.ObjectId, ref: "User" },
    guestId: { type: String, trim: true },
    requestSequence: { type: Number, required: true, min: 1 },
    paymentMethod: {
      type: String,
      enum: Object.values(paymentMethodEnum),
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(substitutionRequestStatusEnum),
      default: substitutionRequestStatusEnum.OFFERED,
      required: true,
    },
    isActive: { type: Boolean, default: true, required: true },
    revision: { type: Number, min: 0, default: 0 },
    offerPresetMinutes: {
      type: Number,
      enum: SUBSTITUTION_EXPIRY_PRESETS,
      default: 30,
    },
    offerExpiresAt: { type: Date, required: true },
    paymentExpiresAt: { type: Date },
    offeredBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    offerIdempotencyKey: { type: String, required: true, trim: true },
    responseIdempotencyKey: { type: String, trim: true },
    responseSubmittedAt: { type: Date },
    shortages: {
      type: [shortageSchema],
      required: true,
      validate: {
        validator: (value) => Array.isArray(value) && value.length > 0,
        message: "At least one shortage is required",
      },
    },
    selections: { type: [selectionSchema], default: [] },
    pricingSnapshot: { type: pricingSnapshotSchema },
    reservation: {
      operationId: { type: String, trim: true },
      state: {
        type: String,
        enum: ["none", "held", "released", "finalized"],
        default: "none",
      },
      items: { type: [reservedSkuSchema], default: [] },
    },
    additionalInstapayScreenshot: { type: String },
    activePaymentAttempt: {
      type: Schema.Types.ObjectId,
      ref: "OrderPaymentAttempt",
    },
    refundOperation: {
      type: Schema.Types.ObjectId,
      ref: "RefundOperation",
    },
    paymentAttempts: {
      type: [{ type: Schema.Types.ObjectId, ref: "OrderPaymentAttempt" }],
      default: [],
    },
    settlementOperationId: { type: String, trim: true },
    terminalReason: { type: String, trim: true },
    finalizedAt: { type: Date },
    lifecycle: { type: [lifecycleEntrySchema], default: [] },
  },
  { timestamps: true },
);

substitutionRequestSchema.pre("validate", function validateOwner() {
  const hasUser = Boolean(this.user);
  const hasGuest = Boolean(this.guestId);
  if (hasUser === hasGuest) {
    this.invalidate("user", "Exactly one of user or guestId is required");
    this.invalidate("guestId", "Exactly one of user or guestId is required");
  }
});

substitutionRequestSchema.index(
  { order: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true },
  },
);
substitutionRequestSchema.index({ order: 1, requestSequence: 1 }, { unique: true });
substitutionRequestSchema.index(
  { order: 1, offerIdempotencyKey: 1 },
  { unique: true },
);
substitutionRequestSchema.index({ status: 1, offerExpiresAt: 1 });
substitutionRequestSchema.index({ status: 1, paymentExpiresAt: 1 });
substitutionRequestSchema.index({
  status: 1,
  refundOperation: 1,
  finalizedAt: 1,
});
substitutionRequestSchema.index({ user: 1, createdAt: -1 });
substitutionRequestSchema.index({ guestId: 1, createdAt: -1 });
substitutionRequestSchema.index({ warehouse: 1, createdAt: -1 });

export const SubstitutionRequestModel = model(
  "SubstitutionRequest",
  substitutionRequestSchema,
);
