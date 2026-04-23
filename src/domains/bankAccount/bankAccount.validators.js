import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const createBankAccountValidator = [
  body("bankName")
    .notEmpty()
    .withMessage("Bank name is required")
    .isString()
    .withMessage("Bank name must be a string"),

  body("accountName")
    .notEmpty()
    .withMessage("Account name is required")
    .isString()
    .withMessage("Account name must be a string"),

  body("accountNumber")
    .notEmpty()
    .withMessage("Account number is required")
    .isString()
    .withMessage("Account number must be a string"),

  validatorMiddleware,
];

export const updateBankAccountValidator = [
  param("id").isMongoId().withMessage("Invalid bank account id"),

  body("bankName")
    .optional()
    .isString()
    .withMessage("Bank name must be a string"),

  body("accountName")
    .optional()
    .isString()
    .withMessage("Account name must be a string"),

  body("accountNumber")
    .optional()
    .isString()
    .withMessage("Account number must be a string"),

  validatorMiddleware,
];

export const bankAccountIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid bank account id"),

  validatorMiddleware,
];
