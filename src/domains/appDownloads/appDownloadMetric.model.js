import mongoose from "mongoose";

const { Schema, model } = mongoose;

const appDownloadMetricSchema = new Schema(
  {
    platform: {
      type: String,
      enum: ["android", "ios"],
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: ["google_play", "app_store_connect"],
      required: true,
    },
    metric: {
      type: String,
      enum: ["daily_user_installs", "app_units"],
      required: true,
    },
    dateKey: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
      index: true,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    downloads: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    reportName: {
      type: String,
      default: "",
    },
    raw: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
  },
  { timestamps: true },
);

appDownloadMetricSchema.index(
  { platform: 1, source: 1, metric: 1, dateKey: 1 },
  { unique: true },
);
appDownloadMetricSchema.index({ platform: 1, dateKey: 1 });

export const AppDownloadMetricModel = model(
  "AppDownloadMetric",
  appDownloadMetricSchema,
);
