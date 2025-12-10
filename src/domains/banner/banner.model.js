import mongoose from "mongoose";

const { Schema, model } = mongoose;

const bannerTargetSchema = new Schema(
  {
    type: {
      type: String,
      required: true,
      trim: true,
    },
    screen: { type: String },
    productId: { type: String },
    categoryId: { type: String },
    subcategoryId: { type: String },
    brandId: { type: String },
    url: { type: String },
  },
  { _id: false }
);

const bannerSchema = new Schema(
  {
    image: {
      public_id: { type: String },
      url: { type: String },
    },
    target: {
      type: bannerTargetSchema,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    position: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

bannerSchema.index({ isActive: 1, position: 1 });

export const BannerModel = model("Banner", bannerSchema);
