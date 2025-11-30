import mongoose from "mongoose";

const { Schema, model } = mongoose;

const warehouseSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    // Optional human-readable location info
    country: {
      type: String,
      trim: true,
      default: "egypt",
    },
    governorate: {
      type: String,
      trim: true,
      lowercase: true,
    },
    address: {
      type: String,
      trim: true,
    },
    // Geo point for future distance calculations
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [lng, lat]
        default: undefined,
      },
    },
    // Optional GeoJSON polygon for configured delivery boundary
    boundaryGeometry: {
      type: {
        type: String,
        enum: ["Polygon"],
      },
      coordinates: {
        type: [[[Number]]], // [ [ [lng, lat], ... ] ]
      },
    },
    defaultShippingPrice: {
      type: Number,
      min: 0,
      default: 0,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

warehouseSchema.index({ code: 1 }, { unique: true });
warehouseSchema.index({ active: 1 });
warehouseSchema.index({ governorate: 1, active: 1 });
warehouseSchema.index({ isDefault: 1 });
warehouseSchema.index({ location: "2dsphere" });

export const WarehouseModel = model("Warehouse", warehouseSchema);
