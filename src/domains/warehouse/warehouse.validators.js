// src/domains/warehouse/warehouse.validators.js
import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const governoratesConfig = require("../../shared/constants/governorates.json");

const egyptianPhoneRegex = /^(?:\+20|20|0)(?:10|11|12|15)\d{8}$/;

const GOVERNORATE_CODES = (governoratesConfig.governorates || []).map(
  (g) => g.code,
);

export const createWarehouseValidator = [
  body("name").notEmpty().withMessage("name is required"),

  body("code")
    .notEmpty()
    .withMessage("code is required")
    .isString()
    .withMessage("code must be a string"),

  body("country").optional().isString().withMessage("country must be a string"),

  body("governorate")
    .optional()
    .trim()
    .toLowerCase()
    .isIn(GOVERNORATE_CODES)
    .withMessage("governorate is invalid"),

  body("address").optional().isString().withMessage("address must be a string"),

  body("email")
    .optional()
    .trim()
    .isEmail()
    .withMessage("Invalid email address"),

  body("phone")
    .optional()
    .matches(egyptianPhoneRegex)
    .withMessage("Phone must be a valid Egyptian mobile number"),

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

  body("boundaryGeometry")
    .optional()
    .isObject()
    .withMessage("boundaryGeometry must be an object"),

  body("boundaryGeometry.type")
    .optional()
    .isIn(["Polygon"])
    .withMessage("boundaryGeometry.type must be 'Polygon'"),

  body("boundaryGeometry.coordinates")
    .optional()
    .isArray({ min: 1 })
    .withMessage("boundaryGeometry.coordinates must be a non-empty array"),

  body("isDefault")
    .optional()
    .isBoolean()
    .withMessage("isDefault must be a boolean"),

  body("defaultShippingPrice")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("defaultShippingPrice must be a non-negative number"),

  body("moderators")
    .optional()
    .isArray()
    .withMessage("moderators must be an array"),

  body("moderators.*")
    .optional()
    .isMongoId()
    .withMessage("Invalid moderator id"),

  validatorMiddleware,
];

export const updateWarehouseValidator = [
  param("id").isMongoId().withMessage("Invalid warehouse id"),

  body("name").optional().isString().withMessage("name must be a string"),

  body("code").optional().isString().withMessage("code must be a string"),

  body("country").optional().isString().withMessage("country must be a string"),

  body("governorate")
    .optional()
    .isIn(GOVERNORATE_CODES)
    .withMessage("governorate is invalid"),

  body("address").optional().isString().withMessage("address must be a string"),

  body("email")
    .optional()
    .trim()
    .isEmail()
    .withMessage("Invalid email address"),

  body("phone")
    .optional()
    .matches(egyptianPhoneRegex)
    .withMessage("Phone must be a valid Egyptian mobile number"),

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

  body("active").optional().isBoolean().withMessage("active must be a boolean"),

  body("moderators")
    .optional()
    .isArray()
    .withMessage("moderators must be an array"),

  body("moderators.*")
    .optional()
    .isMongoId()
    .withMessage("Invalid moderator id"),

  validatorMiddleware,
];

export const warehouseIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid warehouse id"),

  validatorMiddleware,
];
