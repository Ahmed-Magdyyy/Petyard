import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";
import {
  roles,
  enabledControls as enabledControlsEnum,
} from "../../shared/constants/enums.js";

const egyptianPhoneRegex = /^(?:\+20|20|0)(?:10|11|12|15)\d{8}$/;

export const createUserValidator = [
  body("name")
    .trim()
    .notEmpty()
    .withMessage("Name is required")
    .isLength({ min: 3 })
    .withMessage("Name must be at least 3 characters"),

  body("email")
    .notEmpty()
    .withMessage("Email is required")
    .isEmail()
    .withMessage("Invalid email address"),

  body("phone")
    .notEmpty()
    .withMessage("Phone is required")
    .matches(egyptianPhoneRegex)
    .withMessage("Phone must be a valid Egyptian mobile number"),

  body("password")
    .notEmpty()
    .withMessage("Password is required")
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters")
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d]{6,}$/)
    .withMessage("Password must contain uppercase, lowercase, and number"),

  body("role")
    .optional()
    .isIn(Object.values(roles))
    .withMessage("Invalid role"),

  body("enabledControls")
    .optional()
    .isArray()
    .withMessage("enabledControls must be an array")
    .bail()
    .custom((arr, { req }) => {
      if (req.body.role === roles.ADMIN) {
        if (!Array.isArray(arr) || arr.length === 0) {
          throw new Error(
            "enabledControls is required for admin and cannot be empty",
          );
        }
      }

      const allowed = Object.values(enabledControlsEnum);
      const invalid = (arr || []).filter((item) => !allowed.includes(item));
      if (invalid.length) {
        throw new Error("enabledControls contains invalid values");
      }
      return true;
    }),

  validatorMiddleware,
];

export const updateUserValidator = [
  param("id").isMongoId().withMessage("Invalid user id"),

  body("name")
    .optional()
    .trim()
    .isLength({ min: 3 })
    .withMessage("Name must be at least 3 characters"),

  body("phone")
    .optional()
    .matches(egyptianPhoneRegex)
    .withMessage("Phone must be a valid Egyptian mobile number"),

  body("email").optional().isEmail().withMessage("Invalid email address"),

  body("role")
    .optional()
    .isIn(Object.values(roles))
    .withMessage("Invalid role")
    .bail()
    .custom((value, { req }) => {
      // If role is being set to admin, require enabledControls to be non-empty
      if (value === roles.ADMIN) {
        const ec = req.body.enabledControls;
        if (!Array.isArray(ec) || ec.length === 0) {
          throw new Error(
            "enabledControls is required for admin and cannot be empty",
          );
        }
      }
      return true;
    }),

  body("enabledControls")
    .optional()
    .isArray()
    .withMessage("enabledControls must be an array")
    .bail()
    .custom((arr) => {
      const allowed = Object.values(enabledControlsEnum);
      const invalid = (arr || []).filter((item) => !allowed.includes(item));
      if (invalid.length) {
        throw new Error("enabledControls contains invalid values");
      }
      return true;
    }),

  validatorMiddleware,
];

export const updateUserPasswordByAdminValidator = [
  param("id").isMongoId().withMessage("Invalid user id"),

  body("password")
    .notEmpty()
    .withMessage("Password is required")
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters")
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d]{6,}$/)
    .withMessage("Password must contain uppercase, lowercase, and number"),

  validatorMiddleware,
];

export const updateLoggedUserPasswordValidator = [
  body("currentPassword")
    .notEmpty()
    .withMessage("Current password is required"),

  body("newPassword")
    .notEmpty()
    .withMessage("New password is required")
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters")
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d]{6,}$/)
    .withMessage("Password must contain uppercase, lowercase, and number"),

  body("cNewPassword")
    .notEmpty()
    .withMessage("Password confirmation is required")
    .custom((value, { req }) => {
      if (value !== req.body.newPassword) {
        throw new Error("Password confirmation does not match");
      }
      return true;
    }),

  validatorMiddleware,
];

export const updateLoggedUserDataValidator = [
  body("email").optional().isEmail().withMessage("Invalid email address"),

  body("name")
    .optional()
    .isLength({ min: 3 })
    .withMessage("Name must be at least 3 characters"),

  validatorMiddleware,
];

export const updateUserActiveValidator = [
  param("id").isMongoId().withMessage("Invalid user id"),

  validatorMiddleware,
];

export const addressIdParamValidator = [
  param("addressId").isMongoId().withMessage("Invalid address id"),

  validatorMiddleware,
];

export const addMyAddressValidator = [
  body("label")
    .optional({ nullable: true })
    .isString()
    .withMessage("label must be a string"),

  body("name")
    .optional({ nullable: true })
    .isString()
    .withMessage("name must be a string"),

  body("governorate")
    .optional({ nullable: true })
    .isString()
    .withMessage("governorate must be a string"),

  body("area")
    .optional({ nullable: true })
    .isString()
    .withMessage("area must be a string"),

  body("details").notEmpty().withMessage("details is required"),

  body("phone")
    .optional()
    .isString()
    .matches(egyptianPhoneRegex)
    .withMessage("Phone must be a valid Egyptian mobile number"),

  body("location.lat")
    .notEmpty()
    .isFloat()
    .withMessage("location.lat must be a number"),

  body("location.lng")
    .notEmpty()
    .isFloat()
    .withMessage("location.lng must be a number"),

  body("isDefault")
    .optional()
    .isBoolean()
    .withMessage("isDefault must be a boolean"),

  validatorMiddleware,
];

export const updateMyAddressValidator = [
  body("label")
    .optional({ nullable: true })
    .isString()
    .withMessage("label must be a string"),

  body("name")
    .optional({ nullable: true })
    .isString()
    .withMessage("name must be a string"),

  body("governorate")
    .optional({ nullable: true })
    .isString()
    .withMessage("governorate must be a string"),

  body("area")
    .optional({ nullable: true })
    .isString()
    .withMessage("area must be a string"),

  body("details")
    .optional({ nullable: true })
    .isString()
    .withMessage("details must be a string"),

  body("phone")
    .optional({ nullable: true })
    .matches(egyptianPhoneRegex)
    .withMessage("Phone must be a valid Egyptian mobile number"),

  body("location.lat")
    .optional({ nullable: true })
    .isFloat()
    .withMessage("location.lat must be a number"),

  body("location.lng")
    .optional({ nullable: true })
    .isFloat()
    .withMessage("location.lng must be a number"),

  body("isDefault")
    .optional({ nullable: true })
    .isBoolean()
    .withMessage("isDefault must be a boolean"),

  validatorMiddleware,
];

export const setDefaultMyAddressValidator = [
  addressIdParamValidator[0],

  validatorMiddleware,
];
