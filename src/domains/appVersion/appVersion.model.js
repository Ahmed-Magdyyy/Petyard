import mongoose from "mongoose";

const { Schema, model } = mongoose;

export const appVersionPlatforms = Object.freeze({
  ANDROID: "android",
  IOS: "ios",
});

export const appVersionPattern = /^\d+(?:\.\d+)*(?:\+\d+)?$/;

const appVersionReleaseSchema = new Schema(
  {
    platform: {
      type: String,
      enum: Object.values(appVersionPlatforms),
      required: true,
      index: true,
    },
    version: {
      type: String,
      required: true,
      trim: true,
      match: [
        appVersionPattern,
        "Version must be numeric, e.g. 1.2.3 or 1.2.3+45",
      ],
    },
    mustUpdate: {
      type: Boolean,
      required: true,
    },
    releaseNotes: {
      type: String,
      trim: true,
      default: null,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true },
);

appVersionReleaseSchema.index({ platform: 1, version: 1 }, { unique: true });

const appVersionPolicySchema = new Schema(
  {
    platform: {
      type: String,
      enum: Object.values(appVersionPlatforms),
      required: true,
      unique: true,
      index: true,
    },
    latestRelease: {
      type: Schema.Types.ObjectId,
      ref: "AppVersionRelease",
      required: true,
    },
    minRelease: {
      type: Schema.Types.ObjectId,
      ref: "AppVersionRelease",
      required: true,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true },
);

export const AppVersionReleaseModel = model(
  "AppVersionRelease",
  appVersionReleaseSchema,
);

export const AppVersionPolicyModel = model(
  "AppVersionPolicy",
  appVersionPolicySchema,
);
