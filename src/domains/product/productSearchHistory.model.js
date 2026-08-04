import mongoose from "mongoose";

const { Schema, model } = mongoose;

const searchEntrySchema = new Schema(
  {
    q: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    normalized: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    searchedAt: {
      type: Date,
      required: true,
    },
  },
  { _id: false },
);

const productSearchHistorySchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    entries: {
      type: [searchEntrySchema],
      default: [],
      validate: {
        validator: (entries) => entries.length <= 10,
        message: "Search history cannot contain more than 10 entries",
      },
    },
  },
  { timestamps: true },
);

export const ProductSearchHistoryModel = model(
  "ProductSearchHistory",
  productSearchHistorySchema,
);
