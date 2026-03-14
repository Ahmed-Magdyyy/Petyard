import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const createCategoryValidator = [
  body("name_en").notEmpty().withMessage("English name is required"),

  body("name_ar")
    .optional()
    .isString()
    .withMessage("Arabic name must be a string"),

  body("desc_en")
    .optional()
    .isString()
    .withMessage("English description must be a string"),

  body("desc_ar")
    .optional()
    .isString()
    .withMessage("Arabic description must be a string"),

  body("position")
    .optional()
    .isNumeric()
    .withMessage("position must be a number"),

  validatorMiddleware,
];

export const updateCategoryValidator = [
  param("id").isMongoId().withMessage("Invalid category id"),

  body("slug")
    .not()
    .exists()
    .withMessage("slug cannot be updated"),

  body("name_en")
    .optional()
    .isString()
    .withMessage("English name must be a string"),

  body("name_ar")
    .optional()
    .isString()
    .withMessage("Arabic name must be a string"),

  body("desc_en")
    .optional()
    .isString()
    .withMessage("English description must be a string"),

  body("desc_ar")
    .optional()
    .isString()
    .withMessage("Arabic description must be a string"),

  body("position")
    .optional()
    .isNumeric()
    .withMessage("position must be a number"),

  validatorMiddleware,
];

export const categoryIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid category id"),

  validatorMiddleware,
];

export const updateCategoryPositionsValidator = [
  body("positions")
    .isArray({ min: 1, max: 50 })
    .withMessage("positions must be an array with 1–50 items"),

  body("positions.*.id")
    .isMongoId()
    .withMessage("each positions item must have a valid id"),

  body("positions.*.position")
    .isInt({ min: 0 })
    .withMessage("each positions item must have a position (integer >= 0)"),

  validatorMiddleware,
];
