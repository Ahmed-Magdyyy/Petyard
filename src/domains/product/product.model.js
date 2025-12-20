import mongoose from "mongoose";
import { productTypeEnum } from "../../shared/constants/enums.js";

const { Schema, model } = mongoose;

const imageSchema = new Schema(
  {
    public_id: { type: String, required: true },
    url: { type: String, required: true },
    isMain: { type: Boolean, default: false },
  },
  { _id: false }
);

const warehouseStockSchema = new Schema(
  {
    warehouse: {
      type: Schema.Types.ObjectId,
      ref: "Warehouse",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const variantOptionSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    value: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const productOptionSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    values: [
      {
        type: String,
        required: true,
        trim: true,
      },
    ],
  },
  { _id: false }
);

const variantSchema = new Schema(
  {
    sku: { type: String, trim: true },
    price: { type: Number, required: true, min: 0 },
    discountedPrice: {
      type: Number,
      min: 0,
      validate: {
        validator: function (v) {
          if (v == null) return true;
          if (typeof this.price !== "number") return true;
          return v <= this.price;
        },
        message: "discountedPrice cannot be greater than price",
      },
    },
    options: [variantOptionSchema],
    images: [imageSchema],
    warehouseStocks: [warehouseStockSchema],
    isDefault: { type: Boolean, default: false },
  }
);

const productSchema = new Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    type: {
      type: String,
      enum: Object.values(productTypeEnum),
      required: true,
    },
    subcategory: {
      type: Schema.Types.ObjectId,
      ref: "Subcategory",
      required: true,
    },
    category: {
      type: Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    brand: {
      type: Schema.Types.ObjectId,
      ref: "Brand",
    },
    name_en: {
      type: String,
      required: true,
      trim: true,
    },
    name_ar: {
      type: String,
      required: true,
      trim: true,
    },
    desc_en: {
      type: String,
      required: true,
      trim: true,
    },
    desc_ar: {
      type: String,
      required: true,
      trim: true,
    },
    sku: {
      type: String,
      trim: true,
    },
    tags: [
      {
        type: String,
        trim: true,
        lowercase: true,
      },
    ],
    price: {
      type: Number,
      min: 0,
    },
    discountedPrice: {
      type: Number,
      min: 0,
      validate: {
        validator: function (v) {
          if (v == null) return true;
          if (typeof this.price !== "number") return true;
          return v <= this.price;
        },
        message: "discountedPrice cannot be greater than price",
      },
    },
    warehouseStocks: [warehouseStockSchema],
    images: [imageSchema],
    options: [productOptionSchema],
    variants: [variantSchema],
    isActive: {
      type: Boolean,
      default: true,
    },
    isFeatured: {
      type: Boolean,
      default: false,
    },
    ratingAverage: {
      type: Number,
      min: 0,
      max: 5,
      default: 0,
    },
    ratingCount: {
      type: Number,
      min: 0,
      default: 0,
    },
  },
  { timestamps: true }
);

productSchema.index({ subcategory: 1 });
productSchema.index({ category: 1 });
productSchema.index({ brand: 1 });
productSchema.index({ type: 1 });
productSchema.index({ type: 1, "warehouseStocks.warehouse": 1 });
productSchema.index({ type: 1, "variants.warehouseStocks.warehouse": 1 });

export const ProductModel = model("Product", productSchema);
