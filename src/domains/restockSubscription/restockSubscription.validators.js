import { body, param, query } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

const productIdParam = param("productId")
  .notEmpty()
  .withMessage("productId is required")
  .isMongoId()
  .withMessage("productId must be a valid MongoDB ObjectId");

const warehouseQuery = query("warehouse")
  .notEmpty()
  .withMessage("warehouse is required")
  .isMongoId()
  .withMessage("warehouse must be a valid MongoDB ObjectId");

export const subscribeToRestockValidator = [
  body("productId")
    .notEmpty()
    .withMessage("productId is required")
    .isMongoId()
    .withMessage("productId must be a valid MongoDB ObjectId"),
  body("warehouseId")
    .notEmpty()
    .withMessage("warehouseId is required")
    .isMongoId()
    .withMessage("warehouseId must be a valid MongoDB ObjectId"),
  validatorMiddleware,
];

export const restockSubscriptionStatusValidator = [
  productIdParam,
  warehouseQuery,
  validatorMiddleware,
];

export const unsubscribeFromRestockValidator = [
  productIdParam,
  warehouseQuery,
  validatorMiddleware,
];
