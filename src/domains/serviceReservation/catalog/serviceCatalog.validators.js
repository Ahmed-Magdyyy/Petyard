import { body, param } from "express-validator";
import { validatorMiddleware } from "../../../shared/middlewares/validatorMiddleware.js";
import { serviceTypeEnum } from "../../../shared/constants/enums.js";

const validTypes = Object.values(serviceTypeEnum);

export const serviceTypeParamValidator = [
  param("type")
    .notEmpty()
    .withMessage("Service type is required")
    .isString()
    .trim()
    .customSanitizer((v) => v.toUpperCase())
    .isIn(validTypes)
    .withMessage(`Service type must be one of: ${validTypes.join(", ")}`),
  validatorMiddleware,
];

export const createServiceValidator = [
  body("type")
    .notEmpty()
    .withMessage("type is required")
    .isString()
    .trim()
    .customSanitizer((v) => v.toUpperCase())
    .isIn(validTypes)
    .withMessage(`type must be one of: ${validTypes.join(", ")}`),
  body("name_en")
    .notEmpty()
    .withMessage("name_en is required")
    .isString()
    .trim(),
  body("name_ar")
    .notEmpty()
    .withMessage("name_ar is required")
    .isString()
    .trim(),
  body("isActive")
    .optional()
    .isBoolean()
    .withMessage("isActive must be boolean"),

  validatorMiddleware,
];

export const updateServiceValidator = [
  param("type")
    .notEmpty()
    .withMessage("Service type is required")
    .isString()
    .trim()
    .customSanitizer((v) => v.toUpperCase())
    .isIn(validTypes)
    .withMessage(`Service type must be one of: ${validTypes.join(", ")}`),
  body("type")
    .optional()
    .isString()
    .trim()
    .customSanitizer((v) => v.toUpperCase())
    .isIn(validTypes)
    .withMessage(`type must be one of: ${validTypes.join(", ")}`),
  body("name_en").optional().isString().trim(),
  body("name_ar").optional().isString().trim(),
  body("isActive")
    .optional()
    .isBoolean()
    .withMessage("isActive must be boolean"),

  validatorMiddleware,
];
