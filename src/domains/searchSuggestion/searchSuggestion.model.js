import mongoose from "mongoose";

const { Schema, model } = mongoose;

export const SEARCH_SUGGESTION_TYPES = Object.freeze({
  BRAND: "brand",
  SUBCATEGORY: "subcategory",
});

export const SEARCH_SUGGESTION_TARGET_MODELS = Object.freeze({
  [SEARCH_SUGGESTION_TYPES.BRAND]: "Brand",
  [SEARCH_SUGGESTION_TYPES.SUBCATEGORY]: "Subcategory",
});

const searchSuggestionSchema = new Schema(
  {
    targetType: {
      type: String,
      required: true,
      enum: Object.values(SEARCH_SUGGESTION_TYPES),
    },
    targetId: {
      type: Schema.Types.ObjectId,
      required: true,
      refPath: "targetModel",
    },
    targetModel: {
      type: String,
      required: true,
      enum: Object.values(SEARCH_SUGGESTION_TARGET_MODELS),
      validate: {
        validator(value) {
          return SEARCH_SUGGESTION_TARGET_MODELS[this.targetType] === value;
        },
        message: "targetModel must match targetType",
      },
    },
    position: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "position must be a non-negative integer",
      },
    },
  },
  { timestamps: true },
);

searchSuggestionSchema.index(
  { position: 1, createdAt: 1, _id: 1 },
  { name: "search_suggestions_order_idx" },
);
searchSuggestionSchema.index(
  { targetModel: 1, targetId: 1 },
  { unique: true, name: "search_suggestions_target_unique" },
);

export const SearchSuggestionModel = model(
  "SearchSuggestion",
  searchSuggestionSchema,
);
