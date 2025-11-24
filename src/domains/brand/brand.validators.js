import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

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

  validatorMiddleware,
];

export const updateBrandValidator = [
  param("id").isMongoId().withMessage("Invalid brand id"),

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

  validatorMiddleware,
];

export const brandIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid brand id"),

  validatorMiddleware,
];
