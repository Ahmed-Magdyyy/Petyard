import { body } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

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

export const adminSendNotificationValidator = [
  body("target.type")
    .notEmpty()
    .withMessage("target.type is required")
    .isIn(["users"])
    .withMessage("target.type must be 'users'"),

  body("target.userIds")
    .isArray({ min: 1 })
    .withMessage("target.userIds must be a non-empty array"),

  body("target.userIds.*")
    .isMongoId()
    .withMessage("each user id must be a valid Mongo id"),

  body("notification.title")
    .notEmpty()
    .withMessage("notification.title is required")
    .isString()
    .withMessage("notification.title must be a string"),

  body("notification.body")
    .notEmpty()
    .withMessage("notification.body is required")
    .isString()
    .withMessage("notification.body must be a string"),

  body("data")
    .optional()
    .custom((value) => {
      if (value == null) return true;
      if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error("data must be an object");
      }
      return true;
    }),

  validatorMiddleware,
];

export const devSendTestPushValidator = [
  body("token")
    .notEmpty()
    .withMessage("token is required")
    .isString()
    .withMessage("token must be a string"),

  body("title")
    .optional()
    .isString()
    .withMessage("title must be a string"),

  body("body")
    .optional()
    .isString()
    .withMessage("body must be a string"),

  body("data")
    .optional()
    .custom((value) => {
      if (value == null) return true;
      if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error("data must be an object");
      }
      return true;
    }),

  validatorMiddleware,
];
