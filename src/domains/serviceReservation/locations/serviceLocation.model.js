import mongoose from "mongoose";
import { CAIRO_TIMEZONE } from "../reservations/serviceReservation.utils.js";

const { Schema, model } = mongoose;

const serviceLocationSchema = new Schema(
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
    city: {
      type: String,
      required: true,
      trim: true,
    },
    googleMapsLink: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    timezone: {
      type: String,
      default: CAIRO_TIMEZONE,
    },
    active: {
      type: Boolean,
      default: true,
    },
    capacityByRoomType: {
      groomingRoom: {
        type: Number,
        required: true,
        min: 0,
      },
      clinicRoom: {
        type: Number,
        required: true,
        min: 0,
      },
    },
  },
  { timestamps: true }
);

serviceLocationSchema.index({ active: 1 });

export const ServiceLocationModel = model(
  "ServiceLocation",
  serviceLocationSchema
);
