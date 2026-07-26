import mongoose from "mongoose";

import { warehouseFulfillmentStatusEnum } from '../../shared/constants/enums.js';

const { Schema, model } = mongoose;

const warehouseFulfillmentSchema = new Schema(
  {
    status: {
      type: String,
      enum: Object.values(warehouseFulfillmentStatusEnum),
      default: warehouseFulfillmentStatusEnum.OPERATIONAL,
    },
    fallbackWarehouse: {
      type: Schema.Types.ObjectId,
      ref: 'Warehouse',
      default: null,
    },
    statusReason: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { _id: false },
);

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
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    phone: {
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
    boundaryGeometry: {
      type: {
        type: String,
        enum: ["Polygon"],
      },
      coordinates: {
        type: [[[Number]]], // [ [ [lng, lat], ... ] ]
        default: undefined,
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
    moderators: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    active: {
      type: Boolean,
      default: true,
    },
    fulfillment: {
      type: warehouseFulfillmentSchema,
      default: () => ({}),
    },
  },
  { timestamps: true },
);

warehouseSchema.index({ active: 1 });
warehouseSchema.index({ governorate: 1, active: 1 });
warehouseSchema.index({ isDefault: 1 });
warehouseSchema.index({ moderators: 1 });
warehouseSchema.index({ location: "2dsphere" });

export const WarehouseModel = model("Warehouse", warehouseSchema);
