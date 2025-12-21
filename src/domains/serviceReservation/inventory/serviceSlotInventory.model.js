import mongoose from "mongoose";
import { serviceRoomTypeEnum } from "../../../shared/constants/enums.js";

const { Schema, model } = mongoose;

const serviceSlotInventorySchema = new Schema(
  {
    location: {
      type: Schema.Types.ObjectId,
      ref: "ServiceLocation",
      required: true,
      index: true,
    },
    roomType: {
      type: String,
      enum: Object.values(serviceRoomTypeEnum),
      required: true,
      index: true,
    },
    startsAt: {
      type: Date,
      required: true,
      index: true,
    },
    capacity: {
      type: Number,
      required: true,
      min: 0,
    },
    bookedCount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
  },
  { timestamps: true }
);

serviceSlotInventorySchema.index(
  { location: 1, roomType: 1, startsAt: 1 },
  { unique: true }
);

export const ServiceSlotInventoryModel = model(
  "ServiceSlotInventory",
  serviceSlotInventorySchema
);
