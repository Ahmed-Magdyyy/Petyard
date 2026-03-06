import { body } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const updateHomeLayoutValidator = [
  body("sections")
    .isArray({ min: 1 })
    .withMessage("sections must be a non-empty array"),

  body("sections.*.key")
    .notEmpty()
    .withMessage("each section must have a key")
    .isString()
    .withMessage("section key must be a string"),

  body("sections.*.position")
    .isInt({ min: 0 })
    .withMessage("section position must be a non-negative integer"),

  validatorMiddleware,
];
