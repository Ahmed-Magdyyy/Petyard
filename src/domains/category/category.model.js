import mongoose from "mongoose";

const { Schema, model } = mongoose;

const categorySchema = new Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
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

export const CategoryModel = model("Category", categorySchema);
