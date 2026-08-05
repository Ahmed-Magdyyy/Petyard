import mongoose from "mongoose";

const { Schema, model } = mongoose;

export const subcategoryProductDigestStatus = Object.freeze({
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  SENT: "SENT",
});

const subcategoryProductDigestSchema = new Schema(
  {
    subcategory: {
      type: Schema.Types.ObjectId,
      ref: "Subcategory",
      required: true,
    },
    scheduledFor: {
      type: Date,
      required: true,
    },
    productIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "Product",
      },
    ],
    status: {
      type: String,
      enum: Object.values(subcategoryProductDigestStatus),
      default: subcategoryProductDigestStatus.PENDING,
      required: true,
    },
    claimToken: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    lastError: { type: String, default: null, maxlength: 1000 },
  },
  { timestamps: true },
);

subcategoryProductDigestSchema.index(
  { subcategory: 1, scheduledFor: 1 },
  { unique: true, name: "subcategory_product_digest_window" },
);
subcategoryProductDigestSchema.index(
  { status: 1, scheduledFor: 1 },
  { name: "subcategory_product_digest_due" },
);

export const SubcategoryProductDigestModel = model(
  "SubcategoryProductDigest",
  subcategoryProductDigestSchema,
);
