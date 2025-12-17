import mongoose from "mongoose";

const { Schema, model } = mongoose;

const loyaltySettingsSchema = new Schema(
  {
    singleton: {
      type: String,
      default: "SINGLETON",
      required: true,
      unique: true,
      immutable: true,
    },
    pointsEarnRate: {
      type: Number,
      default: 1,
      min: 0,
      required: true,
    },
    pointsRedeemRate: {
      type: Number,
      default: 10,
      min: 1,
      required: true,
    },
    minPointsToRedeem: {
      type: Number,
      default: 500,
      min: 0,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

export const LoyaltySettingsModel = model("LoyaltySettings", loyaltySettingsSchema);

