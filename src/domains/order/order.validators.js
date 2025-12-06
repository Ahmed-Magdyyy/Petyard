import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";
import {
  orderStatusEnum,
  paymentMethodEnum,
} from "../../shared/constants/enums.js";

export const createOrderForUserValidator = [
  body("couponCode")
    .optional({ nullable: true })
    .isString()
    .withMessage("couponCode must be a string"),

  body("paymentMethod")
    .optional()
    .isIn(Object.values(paymentMethodEnum))
    .withMessage("Invalid paymentMethod"),

  body("notes")
    .optional({ nullable: true })
    .isString()
    .withMessage("notes must be a string"),

  validatorMiddleware,
];

export const createOrderForGuestValidator = [
  body("couponCode")
    .optional({ nullable: true })
    .isString()
    .withMessage("couponCode must be a string"),

  body("paymentMethod")
    .optional()
    .isIn(Object.values(paymentMethodEnum))
    .withMessage("Invalid paymentMethod"),

  body("notes")
    .optional({ nullable: true })
    .isString()
    .withMessage("notes must be a string"),

  validatorMiddleware,
];

export const orderIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid order id"),

  validatorMiddleware,
];

export const updateOrderStatusValidator = [
  body("status")
    .notEmpty()
    .withMessage("status is required")
    .isIn(Object.values(orderStatusEnum))
    .withMessage("Invalid order status"),

  validatorMiddleware,
];
