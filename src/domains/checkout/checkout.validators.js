import { body } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const applyCouponValidator = [
  body("couponCode")
    .notEmpty()
    .withMessage("couponCode is required")
    .isString()
    .withMessage("couponCode must be a string"),

  validatorMiddleware,
];
