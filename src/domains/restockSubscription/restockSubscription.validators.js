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

const optionalWarehouseQuery = query("warehouse")
  .optional({ checkFalsy: true })
  .trim()
  .isMongoId()
  .withMessage("warehouse must be a valid MongoDB ObjectId");

const demandPaginationValidators = [
  query("page")
    .default(1)
    .toInt()
    .isInt({ min: 1 })
    .withMessage("page must be a positive integer"),
  query("limit")
    .default(20)
    .toInt()
    .isInt({ min: 1, max: 100 })
    .withMessage("limit must be an integer between 1 and 100"),
];

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

export const restockDemandSummaryValidator = [
  optionalWarehouseQuery,
  query("search")
    .optional({ checkFalsy: true })
    .trim()
    .isString()
    .withMessage("search must be a string")
    .isLength({ max: 120 })
    .withMessage("search must not exceed 120 characters"),
  ...demandPaginationValidators,
  validatorMiddleware,
];

export const restockDemandSubscribersValidator = [
  productIdParam,
  optionalWarehouseQuery,
  ...demandPaginationValidators,
  validatorMiddleware,
];
