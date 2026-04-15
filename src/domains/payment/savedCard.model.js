import mongoose from "mongoose";

const { Schema, model } = mongoose;

const savedCardSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    paymobToken: {
      type: String,
      required: true,
    },
    lastFour: {
      type: String,
      required: true,
    },
    brand: {
      type: String,
      default: "",
    },
    expiryMonth: { type: String },
    expiryYear: { type: String },
  },
  { timestamps: true },
);

savedCardSchema.index({ user: 1, paymobToken: 1 }, { unique: true });

export const SavedCardModel = model("SavedCard", savedCardSchema);
