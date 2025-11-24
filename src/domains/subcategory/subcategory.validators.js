import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const createSubcategoryValidator = [
  body("category")
    .notEmpty()
    .withMessage("category is required")
    .isMongoId()
    .withMessage("category must be a valid id"),

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

export const updateSubcategoryValidator = [
  param("id").isMongoId().withMessage("Invalid subcategory id"),

  body("slug")
    .not()
    .exists()
    .withMessage("slug cannot be updated"),

  body("category")
    .optional()
    .isMongoId()
    .withMessage("category must be a valid id"),

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

export const subcategoryIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid subcategory id"),

  validatorMiddleware,
];
