import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const createBannerValidator = [
  body("targetType")
    .optional()
    .isString()
    .withMessage("targetType must be a string"),

  body("targetScreen")
    .optional()
    .isString()
    .withMessage("targetScreen must be a string"),

  body("targetProductId")
    .optional()
    .isString()
    .withMessage("targetProductId must be a string"),

  body("targetCategoryId")
    .optional()
    .isString()
    .withMessage("targetCategoryId must be a string"),

  body("targetSubcategoryId")
    .optional()
    .isString()
    .withMessage("targetSubcategoryId must be a string"),

  body("targetBrandId")
    .optional()
    .isString()
    .withMessage("targetBrandId must be a string"),

  body("targetUrl")
    .optional()
    .isString()
    .withMessage("targetUrl must be a string"),

  body("isActive")
    .optional()
    .isBoolean()
    .withMessage("isActive must be a boolean")
    .toBoolean(),

  validatorMiddleware,
];

export const updateBannerValidator = [
  param("id").isMongoId().withMessage("Invalid banner id"),

  body("targetType")
    .optional()
    .isString()
    .withMessage("targetType must be a string"),

  body("targetScreen")
    .optional()
    .isString()
    .withMessage("targetScreen must be a string"),

  body("targetProductId")
    .optional()
    .isString()
    .withMessage("targetProductId must be a string"),

  body("targetCategoryId")
    .optional()
    .isString()
    .withMessage("targetCategoryId must be a string"),

  body("targetSubcategoryId")
    .optional()
    .isString()
    .withMessage("targetSubcategoryId must be a string"),

  body("targetBrandId")
    .optional()
    .isString()
    .withMessage("targetBrandId must be a string"),

  body("targetUrl")
    .optional()
    .isString()
    .withMessage("targetUrl must be a string"),

  body("isActive")
    .optional()
    .isBoolean()
    .withMessage("isActive must be a boolean"),

  validatorMiddleware,
];

export const bannerIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid banner id"),

  validatorMiddleware,
];

export const reorderBannersValidator = [
  body("banners")
    .isArray({ min: 1 })
    .withMessage("banners must be a non-empty array"),

  body("banners.*.id")
    .isMongoId()
    .withMessage("Each banner must have a valid id"),

  body("banners.*.position")
    .isInt({ min: 0 })
    .withMessage("Each banner must have a valid position (integer >= 0)"),

  validatorMiddleware,
];
