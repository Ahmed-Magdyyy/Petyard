import mongoose from "mongoose";

const { Schema, model } = mongoose;

const notificationDeviceSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    guestId: {
      type: String,
      index: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    platform: {
      type: String,
      enum: ["android", "ios", "web"],
      default: "android",
    },
    lang: {
      type: String,
      enum: ["en", "ar"],
      default: "en",
    },
    lastUsedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

export const NotificationDeviceModel = model(
  "NotificationDevice",
  notificationDeviceSchema
);
