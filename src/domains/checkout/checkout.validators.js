import { body, query } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const checkoutSummaryValidator = [
  query("warehouseId").optional().isString().isMongoId().withMessage("warehouseId must be a valid id"),
  validatorMiddleware,
];

export const applyCouponValidator = [
  body("couponCode")
    .notEmpty()
    .withMessage("couponCode is required")
    .isString()
    .withMessage("couponCode must be a string"),

  validatorMiddleware,
];
