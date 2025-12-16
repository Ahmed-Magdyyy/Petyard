import mongoose from "mongoose";
import { returnStatusEnum } from "../../shared/constants/enums.js";

const { Schema, model } = mongoose;

const returnRequestSchema = new Schema(
  {
    order: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    status: {
      type: String,
      enum: Object.values(returnStatusEnum),
      default: returnStatusEnum.PENDING,
      required: true,
      index: true,
    },
    refundAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    walletRefund: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    requestedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    processedAt: {
      type: Date,
    },
    processedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: 500,
    },
  },
  { timestamps: true }
);

returnRequestSchema.index({ user: 1, status: 1 });

export const ReturnRequestModel = model("ReturnRequest", returnRequestSchema);
