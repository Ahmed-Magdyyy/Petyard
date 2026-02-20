import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const createCollectionValidator = [
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

  body("isVisible")
    .optional()
    .isBoolean()
    .withMessage("isVisible must be a boolean"),

  body("position")
    .optional()
    .isNumeric()
    .withMessage("position must be a number"),

  body("selector")
    .optional()
    .customSanitizer((value) => {
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    })
    .isObject()
    .withMessage("selector must be an object"),

  body("selector.productIds")
    .optional()
    .isArray()
    .withMessage("selector.productIds must be an array"),

  body("selector.productIds.*")
    .optional()
    .isMongoId()
    .withMessage("each selector.productIds item must be a valid id"),

  body("selector.subcategoryIds")
    .optional()
    .isArray()
    .withMessage("selector.subcategoryIds must be an array"),

  body("selector.subcategoryIds.*")
    .optional()
    .isMongoId()
    .withMessage("each selector.subcategoryIds item must be a valid id"),

  body("selector.brandIds")
    .optional()
    .isArray()
    .withMessage("selector.brandIds must be an array"),

  body("selector.brandIds.*")
    .optional()
    .isMongoId()
    .withMessage("each selector.brandIds item must be a valid id"),

  body("promotion")
    .optional()
    .customSanitizer((value) => {
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    })
    .isObject()
    .withMessage("promotion must be an object"),

  body("promotion.enabled")
    .optional()
    .isBoolean()
    .withMessage("promotion.enabled must be a boolean"),

  body("promotion.discountPercent")
    .optional()
    .isFloat({ min: 0, max: 100 })
    .withMessage("promotion.discountPercent must be between 0 and 100"),

  body("promotion.startsAt")
    .optional()
    .isISO8601()
    .withMessage("promotion.startsAt must be a valid ISO date"),

  body("promotion.endsAt")
    .optional()
    .isISO8601()
    .withMessage("promotion.endsAt must be a valid ISO date"),

  body("promotion.isActive")
    .optional()
    .isBoolean()
    .withMessage("promotion.isActive must be a boolean"),

  body("promotion").custom((value, { req }) => {
    const enabled = req.body?.promotion?.enabled;
    if (enabled === true) {
      if (req.body.promotion.discountPercent == null) {
        throw new Error("promotion.discountPercent is required when promotion.enabled is true");
      }
      if (!req.body.promotion.startsAt) {
        throw new Error("promotion.startsAt is required when promotion.enabled is true");
      }
      if (!req.body.promotion.endsAt) {
        throw new Error("promotion.endsAt is required when promotion.enabled is true");
      }
      const startsAt = new Date(req.body.promotion.startsAt);
      const endsAt = new Date(req.body.promotion.endsAt);
      if (Number.isFinite(startsAt.getTime()) && Number.isFinite(endsAt.getTime())) {
        if (endsAt <= startsAt) {
          throw new Error("promotion.endsAt must be after promotion.startsAt");
        }
      }
    }

    if (
      req.body?.selector?.productIds == null &&
      req.body?.selector?.subcategoryIds == null &&
      req.body?.selector?.brandIds == null
    ) {
      throw new Error(
        "selector must include at least one of productIds, subcategoryIds, or brandIds"
      );
    }

    const hasAnySelector =
      (Array.isArray(req.body?.selector?.productIds) &&
        req.body.selector.productIds.length > 0) ||
      (Array.isArray(req.body?.selector?.subcategoryIds) &&
        req.body.selector.subcategoryIds.length > 0) ||
      (Array.isArray(req.body?.selector?.brandIds) && req.body.selector.brandIds.length > 0);

    if (!hasAnySelector) {
      throw new Error(
        "selector must include at least one of productIds, subcategoryIds, or brandIds"
      );
    }

    return true;
  }),

  validatorMiddleware,
];

export const updateCollectionValidator = [
  param("id").isMongoId().withMessage("Invalid collection id"),

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

  body("isVisible")
    .optional()
    .isBoolean()
    .withMessage("isVisible must be a boolean"),

  body("position")
    .optional()
    .isNumeric()
    .withMessage("position must be a number"),

  body("selector")
    .optional()
    .customSanitizer((value) => {
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    })
    .isObject()
    .withMessage("selector must be an object"),

  body("selector.productIds")
    .optional()
    .isArray()
    .withMessage("selector.productIds must be an array"),

  body("selector.productIds.*")
    .optional()
    .isMongoId()
    .withMessage("each selector.productIds item must be a valid id"),

  body("selector.subcategoryIds")
    .optional()
    .isArray()
    .withMessage("selector.subcategoryIds must be an array"),

  body("selector.subcategoryIds.*")
    .optional()
    .isMongoId()
    .withMessage("each selector.subcategoryIds item must be a valid id"),

  body("selector.brandIds")
    .optional()
    .isArray()
    .withMessage("selector.brandIds must be an array"),

  body("selector.brandIds.*")
    .optional()
    .isMongoId()
    .withMessage("each selector.brandIds item must be a valid id"),

  body("promotion")
    .optional()
    .customSanitizer((value) => {
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    })
    .isObject()
    .withMessage("promotion must be an object"),

  body("promotion.enabled")
    .optional()
    .isBoolean()
    .withMessage("promotion.enabled must be a boolean"),

  body("promotion.discountPercent")
    .optional()
    .isFloat({ min: 0, max: 100 })
    .withMessage("promotion.discountPercent must be between 0 and 100"),

  body("promotion.startsAt")
    .optional()
    .isISO8601()
    .withMessage("promotion.startsAt must be a valid ISO date"),

  body("promotion.endsAt")
    .optional()
    .isISO8601()
    .withMessage("promotion.endsAt must be a valid ISO date"),

  body("promotion.isActive")
    .optional()
    .isBoolean()
    .withMessage("promotion.isActive must be a boolean"),

  body("promotion").custom((value, { req }) => {
    const enabled = req.body?.promotion?.enabled;
    if (enabled === true) {
      if (req.body.promotion.discountPercent == null) {
        throw new Error("promotion.discountPercent is required when promotion.enabled is true");
      }
      if (!req.body.promotion.startsAt) {
        throw new Error("promotion.startsAt is required when promotion.enabled is true");
      }
      if (!req.body.promotion.endsAt) {
        throw new Error("promotion.endsAt is required when promotion.enabled is true");
      }
      const startsAt = new Date(req.body.promotion.startsAt);
      const endsAt = new Date(req.body.promotion.endsAt);
      if (Number.isFinite(startsAt.getTime()) && Number.isFinite(endsAt.getTime())) {
        if (endsAt <= startsAt) {
          throw new Error("promotion.endsAt must be after promotion.startsAt");
        }
      }
    }

    return true;
  }),

  validatorMiddleware,
];

export const collectionIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid collection id"),

  validatorMiddleware,
];

export const updateCollectionPositionsValidator = [
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
