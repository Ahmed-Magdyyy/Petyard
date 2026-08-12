import { body, param, query } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";
import { SEARCH_SUGGESTION_TYPES } from "./searchSuggestion.model.js";

const suggestionTypes = Object.values(SEARCH_SUGGESTION_TYPES);
const editableFields = new Set(["targetType", "targetId", "position"]);

export const listSearchSuggestionsQueryValidator = [
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("page must be a positive integer")
    .toInt(),

  query("limit")
    .optional()
    .isInt({ min: 5, max: 100 })
    .withMessage("limit must be an integer between 5 and 100")
    .toInt(),

  validatorMiddleware,
];

export const createSearchSuggestionValidator = [
  body("targetType")
    .isIn(suggestionTypes)
    .withMessage("targetType must be either brand or subcategory"),

  body("targetId")
    .isMongoId()
    .withMessage("targetId must be a valid MongoDB ObjectId"),

  body("position")
    .optional()
    .isInt({ min: 0 })
    .withMessage("position must be a non-negative integer")
    .toInt(),

  validatorMiddleware,
];

export const updateSearchSuggestionValidator = [
  param("id").isMongoId().withMessage("Invalid search suggestion id"),

  body().custom((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length === 0
    ) {
      throw new Error("At least one editable field is required");
    }

    const unknownFields = Object.keys(value).filter(
      (field) => !editableFields.has(field),
    );
    if (unknownFields.length > 0) {
      throw new Error("Only targetType, targetId, and position can be updated");
    }

    return true;
  }),

  body("targetType")
    .optional()
    .isIn(suggestionTypes)
    .withMessage("targetType must be either brand or subcategory"),

  body("targetId")
    .optional()
    .isMongoId()
    .withMessage("targetId must be a valid MongoDB ObjectId"),

  body("position")
    .optional()
    .isInt({ min: 0 })
    .withMessage("position must be a non-negative integer")
    .toInt(),

  validatorMiddleware,
];

export const searchSuggestionIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid search suggestion id"),

  validatorMiddleware,
];

export const updateSearchSuggestionPositionsValidator = [
  body("positions")
    .isArray({ min: 1, max: 500 })
    .withMessage("positions must be an array with 1-500 items"),

  body("positions").custom((positions) => {
    if (!Array.isArray(positions)) return true;

    const ids = positions
      .map((item) => item?.id)
      .filter(Boolean)
      .map((id) => String(id).toLowerCase());
    if (new Set(ids).size !== ids.length) {
      throw new Error("positions must not contain duplicate ids");
    }

    return true;
  }),

  body("positions.*.id")
    .isMongoId()
    .withMessage("each positions item must have a valid id"),

  body("positions.*.position")
    .isInt({ min: 0 })
    .withMessage(
      "each positions item must have a non-negative integer position",
    )
    .toInt(),

  validatorMiddleware,
];
