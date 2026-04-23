import mongoose from "mongoose";

const { Schema, model } = mongoose;

const standaloneProfileBannerSchema = new Schema(
  {
    image: {
      public_id: { type: String, required: true },
      url: { type: String, required: true },
    },
  },
  { timestamps: true }
);

export const StandaloneProfileBannerModel = model(
  "StandaloneProfileBanner",
  standaloneProfileBannerSchema
);
