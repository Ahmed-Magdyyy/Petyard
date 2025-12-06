import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const createCouponValidator = [
  body("code").notEmpty().withMessage("code is required"),

  body("discountType")
    .optional()
    .customSanitizer((value) => {
      if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed ? trimmed.toUpperCase() : trimmed;
      }
      return value;
    })
    .isIn(["PERCENT", "FIXED"])
    .withMessage("discountType must be either PERCENT or FIXED"),

  body("discountValue")
    .optional()
    .isNumeric()
    .withMessage("discountValue must be a number"),

  body("maxDiscountAmount")
    .optional()
    .isNumeric()
    .withMessage("maxDiscountAmount must be a number"),

  body("freeShipping")
    .optional()
    .isBoolean()
    .withMessage("freeShipping must be a boolean"),

  body("minOrderTotal")
    .optional()
    .isNumeric()
    .withMessage("minOrderTotal must be a number"),

  body("maxOrderTotal")
    .optional()
    .isNumeric()
    .withMessage("maxOrderTotal must be a number"),

  body("isActive")
    .optional()
    .isBoolean()
    .withMessage("isActive must be a boolean"),

  body("startsAt")
    .optional()
    .isISO8601()
    .withMessage("startsAt must be a valid ISO 8601 date"),

  body("expiresAt")
    .optional()
    .isISO8601()
    .withMessage("expiresAt must be a valid ISO 8601 date"),

  body("maxUsageTotal")
    .optional()
    .isInt({ min: 0 })
    .withMessage("maxUsageTotal must be a non-negative integer"),

  body("maxUsagePerUser")
    .optional()
    .isInt({ min: 0 })
    .withMessage("maxUsagePerUser must be a non-negative integer"),

  body("firstOrderOnly")
    .optional()
    .isBoolean()
    .withMessage("firstOrderOnly must be a boolean"),

  body("allowedUserIds")
    .optional()
    .isArray()
    .withMessage("allowedUserIds must be an array"),

  body("allowedUserIds.*")
    .optional()
    .isMongoId()
    .withMessage("each allowedUserIds item must be a valid id"),

  body("discountType").custom((value, { req }) => {
    const { discountType, discountValue, maxDiscountAmount, freeShipping } =
      req.body;

    const hasDiscountType = !!discountType;
    const hasFreeShipping = !!freeShipping;

    if (!hasDiscountType && !hasFreeShipping) {
      throw new Error(
        "Coupon must have at least one effect: discountType or freeShipping"
      );
    }

    if (hasDiscountType) {
      if (discountValue == null || Number(discountValue) <= 0) {
        throw new Error(
          "discountValue must be greater than 0 when discountType is set"
        );
      }
    } else {
      if (discountValue != null || maxDiscountAmount != null) {
        throw new Error(
          "discountValue and maxDiscountAmount must be omitted when discountType is not set"
        );
      }
    }

    return true;
  }),

  body("minOrderTotal").custom((value, { req }) => {
    const { minOrderTotal, maxOrderTotal } = req.body;
    if (minOrderTotal != null && maxOrderTotal != null) {
      const minVal = Number(minOrderTotal);
      const maxVal = Number(maxOrderTotal);
      if (!Number.isNaN(minVal) && !Number.isNaN(maxVal) && minVal > maxVal) {
        throw new Error("minOrderTotal cannot be greater than maxOrderTotal");
      }
    }
    return true;
  }),

  validatorMiddleware,
];

export const updateCouponValidator = [
  param("id").isMongoId().withMessage("Invalid coupon id"),

  body("code")
    .not()
    .exists()
    .withMessage("code cannot be updated"),

  body("discountType")
    .optional()
    .customSanitizer((value) => {
      if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed ? trimmed.toUpperCase() : trimmed;
      }
      return value;
    })
    .isIn(["PERCENT", "FIXED"])
    .withMessage("discountType must be either PERCENT or FIXED"),

  body("discountValue")
    .optional()
    .isNumeric()
    .withMessage("discountValue must be a number"),

  body("maxDiscountAmount")
    .optional()
    .isNumeric()
    .withMessage("maxDiscountAmount must be a number"),

  body("freeShipping")
    .optional()
    .isBoolean()
    .withMessage("freeShipping must be a boolean"),

  body("minOrderTotal")
    .optional()
    .isNumeric()
    .withMessage("minOrderTotal must be a number"),

  body("maxOrderTotal")
    .optional()
    .isNumeric()
    .withMessage("maxOrderTotal must be a number"),

  body("isActive")
    .optional()
    .isBoolean()
    .withMessage("isActive must be a boolean"),

  body("startsAt")
    .optional()
    .isISO8601()
    .withMessage("startsAt must be a valid ISO 8601 date"),

  body("expiresAt")
    .optional()
    .isISO8601()
    .withMessage("expiresAt must be a valid ISO 8601 date"),

  body("maxUsageTotal")
    .optional()
    .isInt({ min: 0 })
    .withMessage("maxUsageTotal must be a non-negative integer"),

  body("maxUsagePerUser")
    .optional()
    .isInt({ min: 0 })
    .withMessage("maxUsagePerUser must be a non-negative integer"),

  body("firstOrderOnly")
    .optional()
    .isBoolean()
    .withMessage("firstOrderOnly must be a boolean"),

  body("allowedUserIds")
    .optional()
    .isArray()
    .withMessage("allowedUserIds must be an array"),

  body("allowedUserIds.*")
    .optional()
    .isMongoId()
    .withMessage("each allowedUserIds item must be a valid id"),

  body("discountType").custom((value, { req }) => {
    const { discountType, discountValue, maxDiscountAmount } = req.body;

    if (
      discountType === undefined &&
      discountValue === undefined &&
      maxDiscountAmount === undefined
    ) {
      return true;
    }

    const hasDiscountType = !!discountType;

    if (hasDiscountType) {
      if (discountValue == null || Number(discountValue) <= 0) {
        throw new Error(
          "discountValue must be greater than 0 when discountType is set"
        );
      }
    } else {
      if (discountValue != null || maxDiscountAmount != null) {
        throw new Error(
          "discountValue and maxDiscountAmount must be omitted when discountType is not set"
        );
      }
    }

    return true;
  }),

  body("minOrderTotal").custom((value, { req }) => {
    const { minOrderTotal, maxOrderTotal } = req.body;
    if (minOrderTotal != null && maxOrderTotal != null) {
      const minVal = Number(minOrderTotal);
      const maxVal = Number(maxOrderTotal);
      if (!Number.isNaN(minVal) && !Number.isNaN(maxVal) && minVal > maxVal) {
        throw new Error("minOrderTotal cannot be greater than maxOrderTotal");
      }
    }
    return true;
  }),

  validatorMiddleware,
];

export const couponIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid coupon id"),

  validatorMiddleware,
];
