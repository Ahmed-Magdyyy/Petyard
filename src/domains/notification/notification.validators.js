import { body, header, param, query } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

// =====================
// Device Registration
// =====================

export const registerDeviceValidator = [
  body("token")
    .notEmpty()
    .withMessage("token is required")
    .isString()
    .withMessage("token must be a string"),

  body("platform")
    .optional()
    .isIn(["android", "ios", "web"])
    .withMessage("platform must be one of: android, ios, web"),

  body("lang")
    .optional()
    .isIn(["en", "ar"])
    .withMessage("lang must be 'en' or 'ar'"),

  validatorMiddleware,
];

export const registerGuestDeviceValidator = [
  header("x-guest-id")
    .notEmpty()
    .withMessage("x-guest-id header is required")
    .isString()
    .withMessage("x-guest-id header must be a string"),

  body("token")
    .notEmpty()
    .withMessage("token is required")
    .isString()
    .withMessage("token must be a string"),

  body("platform")
    .optional()
    .isIn(["android", "ios", "web"])
    .withMessage("platform must be one of: android, ios, web"),

  body("lang")
    .optional()
    .isIn(["en", "ar"])
    .withMessage("lang must be 'en' or 'ar'"),

  validatorMiddleware,
];

// =====================
// User Notification Validators
// =====================

export const listNotificationsQueryValidator = [
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("page must be a positive integer"),

  query("limit")
    .optional()
    .isInt({ min: 1, max: 50 })
    .withMessage("limit must be between 1 and 50"),

  query("isRead")
    .optional()
    .isIn(["true", "false"])
    .withMessage("isRead must be 'true' or 'false'"),

  validatorMiddleware,
];

export const notificationIdParamValidator = [
  param("id")
    .isMongoId()
    .withMessage("Invalid notification id"),

  validatorMiddleware,
];

// =====================
// Admin Send Notification
// =====================

export const adminSendNotificationValidator = [
  body("target.type")
    .notEmpty()
    .withMessage("target.type is required")
    .isIn(["users", "all_users", "all_devices"])
    .withMessage("target.type must be 'users', 'all_users', or 'all_devices'"),

  body("target.userIds")
    .optional()
    .isArray({ min: 1 })
    .withMessage("target.userIds must be a non-empty array"),

  body("target.userIds.*")
    .optional()
    .isMongoId()
    .withMessage("each user id must be a valid Mongo id"),

  // Notification content (support both old and new i18n format)
  body("notification")
    .notEmpty()
    .withMessage("notification is required")
    .isObject()
    .withMessage("notification must be an object"),

  body("notification")
    .custom((value) => {
      // Must have either title or title_en
      const hasTitle = value.title || value.title_en;
      const hasBody = value.body || value.body_en;
      if (!hasTitle) {
        throw new Error("notification.title or notification.title_en is required");
      }
      if (!hasBody) {
        throw new Error("notification.body or notification.body_en is required");
      }
      return true;
    }),

  // Icon type
  body("icon")
    .optional()
    .isIn(["order", "promo", "appointment", "product", "pet", "wallet", "loyalty", "system"])
    .withMessage("icon must be one of: order, promo, appointment, product, pet, wallet, loyalty, system"),

  // Action for deep linking
  body("action")
    .optional()
    .isObject()
    .withMessage("action must be an object"),

  body("action.type")
    .optional()
    .isString()
    .withMessage("action.type must be a string"),

  body("action.screen")
    .optional()
    .isString()
    .withMessage("action.screen must be a string"),

  body("action.params")
    .optional()
    .isObject()
    .withMessage("action.params must be an object"),

  // Channel control
  body("channels")
    .optional()
    .isObject()
    .withMessage("channels must be an object"),

  body("channels.push")
    .optional()
    .isBoolean()
    .withMessage("channels.push must be a boolean"),

  body("channels.inApp")
    .optional()
    .isBoolean()
    .withMessage("channels.inApp must be a boolean"),

  validatorMiddleware,
];

