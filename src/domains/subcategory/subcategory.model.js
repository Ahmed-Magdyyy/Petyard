import mongoose from "mongoose";

const { Schema, model } = mongoose;

const subcategorySchema = new Schema(
  {
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    category: {
      type: Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    name_en: {
      type: String,
      required: true,
      trim: true,
    },
    name_ar: {
      type: String,
      trim: true,
    },
    desc_en: {
      type: String,
      trim: true,
    },
    desc_ar: {
      type: String,
      trim: true,
    },
    image: {
      public_id: { type: String },
      url: { type: String },
    },
  },
  { timestamps: true }
);

subcategorySchema.index({ category: 1, slug: 1 }, { unique: true });
subcategorySchema.index({ category: 1 });

export const SubcategoryModel = model("Subcategory", subcategorySchema);
