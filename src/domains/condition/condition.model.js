import mongoose from "mongoose";

const { Schema, model } = mongoose;

const conditionSchema = new Schema(
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
      required: true,
      enum: ["chronic", "temporary"],
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
    visible: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

conditionSchema.index({ slug: 1 }, { unique: true });
conditionSchema.index({ type: 1, visible: 1 });

export const ConditionModel = model("Condition", conditionSchema);
