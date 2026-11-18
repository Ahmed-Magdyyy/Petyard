import { body, header, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";
import {
  orderStatusEnum,
  orderPlatformEnum,
  paymentMethodEnum,
} from "../../shared/constants/enums.js";
import { getInstapayScreenshotFiles } from "./order.instapay.js";

const orderPlatformHeader = header("x-app-platform")
  .optional()
  .custom((value) =>
    [orderPlatformEnum.ANDROID, orderPlatformEnum.IOS, orderPlatformEnum.WEB].includes(value),
  )
  .withMessage("X-App-Platform must be one of: android, ios, web");

export const createOrderForUserValidator = [
  orderPlatformHeader,
  // Reject the retired request explicitly; ignoring it could place an ordinary order by mistake.
  body("bundleCheckout")
    .not().exists()
    .withMessage("Bundle checkout is unavailable while its integration is being revised"),
  body("couponCode")
    .optional({ nullable: true })
    .isString()
    .withMessage("couponCode must be a string"),

  body("paymentMethod")
    .optional()
    .isIn(Object.values(paymentMethodEnum))
    .withMessage("Invalid paymentMethod")
    .custom((val, { req }) => {
      if (
        val === paymentMethodEnum.INSTAPAY &&
        getInstapayScreenshotFiles(req).length === 0
      ) {
        throw new Error("instapay screenshot is required for instapay payment method");
      }
      return true;
    }),

  body("savedCardId")
    .optional({ nullable: true })
    .isMongoId()
    .withMessage("savedCardId must be a valid ID"),

  body("notes")
    .optional({ nullable: true })
    .isString()
    .withMessage("notes must be a string"),

  validatorMiddleware,
];

export const createOrderForGuestValidator = [
  orderPlatformHeader,
  body("couponCode")
    .optional({ nullable: true })
    .isString()
    .withMessage("couponCode must be a string"),

  body("paymentMethod")
    .optional()
    .isIn(Object.values(paymentMethodEnum))
    .withMessage("Invalid paymentMethod")
    .custom((val, { req }) => {
      if (
        val === paymentMethodEnum.INSTAPAY &&
        getInstapayScreenshotFiles(req).length === 0
      ) {
        throw new Error("instapay screenshot is required for instapay payment method");
      }
      return true;
    }),

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
