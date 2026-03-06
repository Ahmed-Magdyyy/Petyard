import mongoose from "mongoose";

const { Schema, model } = mongoose;

const sectionSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
    },
    name_en: {
      type: String,
      required: true,
    },
    name_ar: {
      type: String,
      required: true,
    },
    position: {
      type: Number,
      required: true,
      min: 0,
    },
    isVisible: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false },
);

const homeLayoutSchema = new Schema(
  {
    sections: {
      type: [sectionSchema],
      default: [],
    },
  },
  { timestamps: true },
);

export const HomeLayoutModel = model("HomeLayout", homeLayoutSchema);
