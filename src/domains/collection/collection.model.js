import mongoose from "mongoose";

const { Schema, model } = mongoose;

const collectionSelectorSchema = new Schema(
  {
    productIds: [{ type: Schema.Types.ObjectId, ref: "Product" }],
    subcategoryIds: [{ type: Schema.Types.ObjectId, ref: "Subcategory" }],
    brandIds: [{ type: Schema.Types.ObjectId, ref: "Brand" }],
  },
  { _id: false }
);

const collectionPromotionSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    discountPercent: { type: Number, min: 0, max: 100 },
    startsAt: { type: Date },
    endsAt: { type: Date },
    isActive: { type: Boolean, default: true },
  },
  { _id: false }
);

const collectionSchema = new Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    name_en: { type: String, required: true, trim: true },
    name_ar: { type: String, trim: true },
    desc_en: { type: String, trim: true },
    desc_ar: { type: String, trim: true },
    image: {
      public_id: { type: String },
      url: { type: String },
    },
    isVisible: { type: Boolean, default: true, index: true },
    position: { type: Number, default: 0 },
    selector: {
      type: collectionSelectorSchema,
      default: () => ({}),
    },
    promotion: {
      type: collectionPromotionSchema,
      default: () => ({}),
    },
  },
  { timestamps: true }
);

collectionSchema.index({ isVisible: 1, position: 1 });
collectionSchema.index({ "promotion.enabled": 1, "promotion.isActive": 1, "promotion.startsAt": 1, "promotion.endsAt": 1 });

export const CollectionModel = model("Collection", collectionSchema);
