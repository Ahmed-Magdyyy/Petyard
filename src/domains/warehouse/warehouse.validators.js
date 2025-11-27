// src/domains/warehouse/warehouse.validators.js
import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";
import { GOVERNORATES } from "../../shared/constants/enums.js";

export const createWarehouseValidator = [
  body("name").notEmpty().withMessage("name is required"),

  body("code")
    .notEmpty()
    .withMessage("code is required")
    .isString()
    .withMessage("code must be a string"),

  body("country")
    .optional()
    .isString()
    .withMessage("country must be a string"),

  body("governorate")
    .optional()
    .trim()
    .toLowerCase()
    .isIn(Object.values(GOVERNORATES))
    .withMessage("governorate is invalid"),

  body("address")
    .optional()
    .isString()
    .withMessage("address must be a string"),

  body("location")
    .optional()
    .isObject()
    .withMessage("location must be an object"),

  body("location.type")
    .optional()
    .isIn(["Point"])
    .withMessage("location.type must be 'Point'"),

  body("location.coordinates")
    .optional()
    .isArray({ min: 2, max: 2 })
    .withMessage("location.coordinates must be [lng, lat]"),

  body("isDefault")
    .optional()
    .isBoolean()
    .withMessage("isDefault must be a boolean"),
  
  body("defaultShippingPrice")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("defaultShippingPrice must be a non-negative number"),

  validatorMiddleware,
];

export const updateWarehouseValidator = [
  param("id").isMongoId().withMessage("Invalid warehouse id"),

  body("name")
    .optional()
    .isString()
    .withMessage("name must be a string"),

  body("code")
    .optional()
    .isString()
    .withMessage("code must be a string"),

  body("country")
    .optional()
    .isString()
    .withMessage("country must be a string"),

  body("governorate")
    .optional()
    .isIn(Object.values(GOVERNORATES))
    .withMessage("governorate is invalid"),

  body("address")
    .optional()
    .isString()
    .withMessage("address must be a string"),

  body("location")
    .optional()
    .isObject()
    .withMessage("location must be an object"),

  body("location.type")
    .optional()
    .isIn(["Point"])
    .withMessage("location.type must be 'Point'"),

  body("location.coordinates")
    .optional()
    .isArray({ min: 2, max: 2 })
    .withMessage("location.coordinates must be [lng, lat]"),

  body("defaultShippingPrice")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("defaultShippingPrice must be a non-negative number"),

  body("isDefault")
    .optional()
    .isBoolean()
    .withMessage("isDefault must be a boolean"),

  body("active")
    .optional()
    .isBoolean()
    .withMessage("active must be a boolean"),

  validatorMiddleware,
];

export const warehouseIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid warehouse id"),

  validatorMiddleware,
];

export const generateWarehouseGridValidator = [
  param("id").isMongoId().withMessage("Invalid warehouse id"),

  body("radiusKm")
    .optional()
    .isFloat({ min: 0.1 })
    .withMessage("radiusKm must be a positive number in kilometers"),

  body("cellSideKm")
    .optional()
    .isFloat({ min: 0.1 })
    .withMessage("cellSideKm must be a positive number in kilometers"),

  body("overwrite")
    .optional()
    .isBoolean()
    .withMessage("overwrite must be a boolean"),

  validatorMiddleware,
];

export const updateWarehouseZonesGridValidator = [
  param("id").isMongoId().withMessage("Invalid warehouse id"),

  body("zones")
    .isArray({ min: 1 })
    .withMessage("zones must be a non-empty array"),

  body("zones.*.id")
    .notEmpty()
    .withMessage("zones.*.id is required")
    .isMongoId()
    .withMessage("zones.*.id must be a valid id"),

  body("zones.*._action")
    .optional()
    .isString()
    .withMessage("zones.*._action must be a string"),

  body("zones.*.active")
    .optional()
    .isBoolean()
    .withMessage("zones.*.active must be a boolean"),

  body("zones.*.name")
    .optional()
    .isString()
    .withMessage("zones.*.name must be a string"),

  body("zones.*.shippingFee")
    .optional({ nullable: true })
    .custom((value) => {
      if (value === null || typeof value === "undefined") return true;
      if (typeof value !== "number") {
        throw new Error("zones.*.shippingFee must be a number or null");
      }
      if (value < 0) {
        throw new Error("zones.*.shippingFee must be a non-negative number");
      }
      return true;
    }),

  body("zones.*.areaName")
    .optional({ nullable: true })
    .isString()
    .withMessage("zones.*.areaName must be a string"),

  validatorMiddleware,
];
