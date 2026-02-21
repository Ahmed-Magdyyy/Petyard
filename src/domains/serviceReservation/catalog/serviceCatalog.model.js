import mongoose from "mongoose";

const { Schema, model } = mongoose;

const serviceOptionSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    name_en: { type: String, required: true, trim: true },
    name_ar: { type: String, required: true, trim: true },
    price: { type: Number, required: true },
  },
  { _id: false },
);

const serviceCatalogSchema = new Schema(
  {
    type: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    name_en: { type: String, required: true, trim: true },
    name_ar: { type: String, required: true, trim: true },
    image: {
      public_id: { type: String },
      url: { type: String },
    },
    isActive: { type: Boolean, default: true },
    options: [serviceOptionSchema],
  },
  { timestamps: true },
);

serviceCatalogSchema.index({ isActive: 1 });

export const ServiceCatalogModel = model(
  "ServiceCatalog",
  serviceCatalogSchema,
);
