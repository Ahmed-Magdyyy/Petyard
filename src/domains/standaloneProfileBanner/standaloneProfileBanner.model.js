import mongoose from "mongoose";

const { Schema, model } = mongoose;

const standaloneProfileBannerSchema = new Schema(
  {
    image: {
      public_id: { type: String, required: true },
      url: { type: String, required: true },
    },
  },
  { timestamps: true },
);

standaloneProfileBannerSchema.set("toJSON", {
  transform: (doc, ret) => {
    delete ret._id;
    delete ret.__v;
    if (ret.image && ret.image.url) {
      ret.image = ret.image.url;
    }
    return ret;
  },
});

export const StandaloneProfileBannerModel = model(
  "StandaloneProfileBanner",
  standaloneProfileBannerSchema,
);
