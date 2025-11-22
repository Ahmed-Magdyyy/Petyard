import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

const conditionTypes = ["chronic", "temporary"];

export const createConditionValidator = [
  body("type")
    .notEmpty()
    .withMessage("type is required")
    .isIn(conditionTypes)
    .withMessage("type must be either 'chronic' or 'temporary'"),

  body("name_en")
    .notEmpty()
    .withMessage("English name is required"),

  body("name_ar")
    .optional()
    .isString()
    .withMessage("Arabic name must be a string"),

  validatorMiddleware,
];

export const updateConditionValidator = [
  param("id").isMongoId().withMessage("Invalid condition id"),

  body("slug")
    .not()
    .exists()
    .withMessage("slug cannot be updated"),

  body("type")
    .optional()
    .isIn(conditionTypes)
    .withMessage("type must be either 'chronic' or 'temporary'"),

  body("name_en")
    .optional()
    .isString()
    .withMessage("English name must be a string"),

  body("name_ar")
    .optional()
    .isString()
    .withMessage("Arabic name must be a string"),

  body("visible")
    .optional()
    .isBoolean()
    .withMessage("visible must be a boolean"),

  validatorMiddleware,
];

export const conditionIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid condition id"),

  validatorMiddleware,
];
