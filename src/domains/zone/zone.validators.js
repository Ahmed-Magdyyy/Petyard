// src/domains/zone/zone.validators.js
import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";
const geometryValidator = (value) => {
  if (typeof value !== "object" || value === null) {
    throw new Error("geometry must be an object");
  }
  if (value.type !== "Polygon") {
    throw new Error("geometry.type must be 'Polygon'");
  }
  if (!Array.isArray(value.coordinates)) {
    throw new Error("geometry.coordinates must be an array");
  }
  return true;
};

export const createZoneValidator = [
  body("name").notEmpty().withMessage("name is required"),

  body("areaName")
    .optional()
    .isString()
    .withMessage("areaName must be a string"),

  body("warehouse")
    .notEmpty()
    .withMessage("warehouse is required")
    .isMongoId()
    .withMessage("warehouse must be a valid id"),

  body("country")
    .optional()
    .isString()
    .withMessage("country must be a string"),

  body("geometry")
    .notEmpty()
    .withMessage("geometry is required")
    .bail()
    .custom(geometryValidator),

  body("shippingFee")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("shippingFee must be a non-negative number"),

  body("active")
    .optional()
    .isBoolean()
    .withMessage("active must be a boolean"),

  validatorMiddleware,
];

export const resolveZoneLocationValidator = [
  body("lat")
    .notEmpty()
    .withMessage("lat is required")
    .isFloat({ min: -90, max: 90 })
    .withMessage("lat must be a valid latitude"),

  body("lng")
    .notEmpty()
    .withMessage("lng is required")
    .isFloat({ min: -180, max: 180 })
    .withMessage("lng must be a valid longitude"),

  validatorMiddleware,
];

export const updateZoneValidator = [
  param("id").isMongoId().withMessage("Invalid zone id"),

  body("name")
    .optional()
    .isString()
    .withMessage("name must be a string"),

  body("areaName")
    .optional()
    .isString()
    .withMessage("areaName must be a string"),

  body("warehouse")
    .optional()
    .isMongoId()
    .withMessage("warehouse must be a valid id"),

  body("country")
    .optional()
    .isString()
    .withMessage("country must be a string"),

  body("geometry")
    .optional()
    .custom(geometryValidator),

  body("shippingFee")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("shippingFee must be a non-negative number"),

  body("active")
    .optional()
    .isBoolean()
    .withMessage("active must be a boolean"),

  validatorMiddleware,
];

export const zoneIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid zone id"),

  validatorMiddleware,
];
