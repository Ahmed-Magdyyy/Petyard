import { query } from "express-validator";
import mongoose from "mongoose";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

// ─── Reusable field validators ───────────────────────────────────────────────

const isValidMongoId = (value) => mongoose.Types.ObjectId.isValid(value);

const optionalIsoDate = (fieldName) =>
  query(fieldName)
    .optional()
    .isISO8601()
    .withMessage(`${fieldName} must be a valid ISO 8601 date`);

const optionalMongoId = (fieldName) =>
  query(fieldName)
    .optional()
    .custom((value) => {
      if (!isValidMongoId(value)) {
        throw new Error(`${fieldName} must be a valid MongoDB ObjectId`);
      }
      return true;
    });

/**
 * Cross-field rule: `from` and `to` must both be present or both absent.
 * When both are present, `from` must be ≤ `to`.
 */
const fromToPairValidator = query("from").custom((value, { req }) => {
  const { from, to } = req.query;
  const hasFrom = from !== undefined && from !== "";
  const hasTo = to !== undefined && to !== "";

  if (hasFrom !== hasTo) {
    throw new Error("Both 'from' and 'to' must be provided together");
  }

  if (hasFrom && hasTo && new Date(from) > new Date(to)) {
    throw new Error("'from' must be earlier than or equal to 'to'");
  }

  return true;
});

// ─── Exported validators (one per endpoint) ──────────────────────────────────

/**
 * GET /analytics/orders
 * Query: from?, to?, warehouse?
 */
export const ordersOverviewValidator = [
  optionalIsoDate("from"),
  optionalIsoDate("to"),
  fromToPairValidator,
  optionalMongoId("warehouse"),
  validatorMiddleware,
];

/**
 * GET /analytics/orders/top-products
 * Query: from?, to?, warehouse?, limit?
 */
export const topProductsValidator = [
  optionalIsoDate("from"),
  optionalIsoDate("to"),
  fromToPairValidator,
  optionalMongoId("warehouse"),
  query("limit")
    .optional()
    .isInt({ min: 1, max: 50 })
    .withMessage("limit must be an integer between 1 and 50"),
  validatorMiddleware,
];

/**
 * GET /analytics/services
 * Query: from?, to?, location?
 */
export const servicesOverviewValidator = [
  optionalIsoDate("from"),
  optionalIsoDate("to"),
  fromToPairValidator,
  optionalMongoId("location"),
  validatorMiddleware,
];

/**
 * GET /analytics/stats
 * Query: from?, to?
 */
export const statsValidator = [
  optionalIsoDate("from"),
  optionalIsoDate("to"),
  fromToPairValidator,
  validatorMiddleware,
];

/**
 * GET /analytics/sales-chart
 * Query: from?, to?, warehouse?, location?
 */
export const salesChartValidator = [
  optionalIsoDate("from"),
  optionalIsoDate("to"),
  fromToPairValidator,
  optionalMongoId("warehouse"),
  optionalMongoId("location"),
  validatorMiddleware,
];
