import { body, param, query } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const brandListQueryValidator = [
  query("sort")
    .optional()
    .isIn(["position", "alphabet"])
    .withMessage("sort must be either position or alphabet"),

  validatorMiddleware,
];

export const createBrandValidator = [
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

  body("bgColor")
    .optional()
    .isString()
    .matches(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
    .withMessage("bgColor must be a hex color such as #FFF or #FFFFFF"),

  body("position")
    .optional()
    .isInt({ min: 0 })
    .withMessage("position must be a non-negative integer")
    .toInt(),

  validatorMiddleware,
];

export const updateBrandValidator = [
  param("id").isMongoId().withMessage("Invalid brand id"),

  body("slug").not().exists().withMessage("slug cannot be updated"),

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

  body("bgColor")
    .optional()
    .isString()
    .matches(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
    .withMessage("bgColor must be a hex color such as #FFF or #FFFFFF"),

  body("position")
    .optional()
    .isInt({ min: 0 })
    .withMessage("position must be a non-negative integer")
    .toInt(),

  validatorMiddleware,
];

export const brandIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid brand id"),

  validatorMiddleware,
];

export const updateBrandPositionsValidator = [
  body("positions")
    .isArray({ min: 1, max: 500 })
    .withMessage("positions must be an array with 1-500 items"),

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
