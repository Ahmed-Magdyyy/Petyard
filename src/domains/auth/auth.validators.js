import { body } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

const egyptianPhoneRegex = /^(?:\+20|20|0)(?:10|11|12|15)\d{8}$/;

export const signupValidator = [
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
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[^\s]{6,}$/)
    .withMessage("Password must contain uppercase, lowercase, and number"),

  body("cPassword")
    .notEmpty()
    .withMessage("Password confirmation is required")
    .custom((value, { req }) => {
      if (value !== req.body.password) {
        throw new Error("Password confirmation does not match");
      }
      return true;
    }),

  validatorMiddleware,
];

export const resendOtpValidator = [
  body("identifier")
    .notEmpty()
    .withMessage("Identifier is required (email or phone)")
    .custom((value) => {
      const trimmed = String(value).trim();
      const isEmail = /.+@.+\..+/.test(trimmed);
      const isEgyptianPhone = egyptianPhoneRegex.test(trimmed);

      if (!isEmail && !isEgyptianPhone) {
        throw new Error(
          "Identifier must be a valid email or Egyptian phone number",
        );
      }
      return true;
    }),

  validatorMiddleware,
];

export const verifyPhoneValidator = [
  body("identifier")
    .notEmpty()
    .withMessage("Identifier is required (email or phone)")
    .custom((value) => {
      const trimmed = String(value).trim();
      const isEmail = /.+@.+\..+/.test(trimmed);
      const isEgyptianPhone = egyptianPhoneRegex.test(trimmed);

      if (!isEmail && !isEgyptianPhone) {
        throw new Error(
          "Identifier must be a valid email or Egyptian phone number",
        );
      }
      return true;
    }),

  body("otp")
    .notEmpty()
    .withMessage("OTP is required")
    .isLength({ min: 6, max: 6 })
    .withMessage("OTP must be 6 digits")
    .matches(/^[0-9]+$/)
    .withMessage("OTP must be numeric"),

  validatorMiddleware,
];

export const guestSendOtpValidator = [
  body("phone")
    .notEmpty()
    .withMessage("Phone is required")
    .matches(egyptianPhoneRegex)
    .withMessage("Phone must be a valid Egyptian mobile number"),

  validatorMiddleware,
];

export const oauthGoogleLoginValidator = [
  body("idToken").notEmpty().withMessage("idToken is required"),
  validatorMiddleware,
];

export const oauthAppleLoginValidator = [
  body("identityToken").notEmpty().withMessage("identityToken is required"),
  body("nonce").optional().isString().withMessage("nonce must be a string"),
  body("name").optional().isString().withMessage("name must be a string"),
  body("pictureUrl")
    .optional()
    .isString()
    .withMessage("pictureUrl must be a string"),
  validatorMiddleware,
];

export const oauthSendOtpValidator = [
  body("phone")
    .notEmpty()
    .withMessage("Phone is required")
    .matches(egyptianPhoneRegex)
    .withMessage("Phone must be a valid Egyptian mobile number"),
  validatorMiddleware,
];

export const oauthVerifyPhoneValidator = [
  body("phone")
    .notEmpty()
    .withMessage("Phone is required")
    .matches(egyptianPhoneRegex)
    .withMessage("Phone must be a valid Egyptian mobile number"),
  body("otp")
    .notEmpty()
    .withMessage("OTP is required")
    .isLength({ min: 6, max: 6 })
    .withMessage("OTP must be 6 digits")
    .matches(/^[0-9]+$/)
    .withMessage("OTP must be numeric"),
  validatorMiddleware,
];

export const oauthLinkGoogleValidator = [
  body("idToken").notEmpty().withMessage("idToken is required"),
  validatorMiddleware,
];

export const oauthLinkAppleValidator = [
  body("identityToken").notEmpty().withMessage("identityToken is required"),
  body("nonce").optional().isString().withMessage("nonce must be a string"),
  body("pictureUrl")
    .optional()
    .isString()
    .withMessage("pictureUrl must be a string"),
  validatorMiddleware,
];

export const oauthSetPasswordValidator = [
  body("newPassword")
    .notEmpty()
    .withMessage("New password is required")
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters")
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[^\s]{6,}$/)
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

export const guestVerifyOtpValidator = [
  body("phone")
    .notEmpty()
    .withMessage("Phone is required")
    .matches(egyptianPhoneRegex)
    .withMessage("Phone must be a valid Egyptian mobile number"),

  body("otp")
    .notEmpty()
    .withMessage("OTP is required")
    .isLength({ min: 6, max: 6 })
    .withMessage("OTP must be 6 digits")
    .matches(/^[0-9]+$/)
    .withMessage("OTP must be numeric"),

  validatorMiddleware,
];

export const loginValidator = [
  body("identifier")
    .notEmpty()
    .withMessage("Identifier is required (email or phone)")
    .custom((value) => {
      const trimmed = String(value).trim();

      const isEmail = /.+@.+\..+/.test(trimmed);
      const isEgyptianPhone = egyptianPhoneRegex.test(trimmed);

      if (!isEmail && !isEgyptianPhone) {
        throw new Error(
          "Identifier must be a valid email or Egyptian phone number",
        );
      }
      return true;
    }),

  body("password")
    .notEmpty()
    .withMessage("Password is required")
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters")
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[^\s]{6,}$/)
    .withMessage("Password must contain uppercase, lowercase, and number"),

  validatorMiddleware,
];

export const forgetPasswordValidator = [
  body("email")
    .notEmpty()
    .withMessage("Email is required")
    .isEmail()
    .withMessage("Invalid email address"),

  validatorMiddleware,
];

export const verifyResetCodeValidator = [
  body("resetCode")
    .notEmpty()
    .withMessage("Reset code is required")
    .isLength({ min: 6, max: 6 })
    .withMessage("Reset code must be 6 digits")
    .matches(/^[0-9]+$/)
    .withMessage("Reset code must be numeric"),

  validatorMiddleware,
];

export const resetPasswordValidator = [
  body("email")
    .notEmpty()
    .withMessage("Email is required")
    .isEmail()
    .withMessage("Invalid email address"),

  body("newPassword")
    .notEmpty()
    .withMessage("New password is required")
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters")
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[^\s]{6,}$/)
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
