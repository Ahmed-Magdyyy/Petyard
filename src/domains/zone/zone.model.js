import mongoose from "mongoose";

const { Schema, model } = mongoose;

const zoneSchema = new Schema(
  {
    name: {
      type: String,
      trim: true,
    },
    areaName: {
      type: String,
      trim: true,
      lowercase: true,
    },
    country: {
      type: String,
      trim: true,
      default: "egypt",
    },
    governorate: {
      type: String,
      trim: true,
    },
    geometry: {
      type: {
        type: String,
        enum: ["Polygon"],
      },
      coordinates: {
        type: [[[Number]]],
      },
    },
    warehouse: {
      type: Schema.Types.ObjectId,
      ref: "Warehouse",
      required: true,
    },
    shippingFee: {
      type: Number,
      min: 0,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

zoneSchema.index({ warehouse: 1, active: 1 });
zoneSchema.index({ country: 1, governorate: 1, city: 1, district: 1, active: 1 });
zoneSchema.index({ geometry: "2dsphere", active: 1 });

export const ZoneModel = model("Zone", zoneSchema);
