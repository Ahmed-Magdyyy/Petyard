import { body, param, query } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";
import { returnStatusEnum } from "../../shared/constants/enums.js";

export const createReturnRequestValidator = [
  param("orderId").isMongoId().withMessage("Invalid order ID"),
  body("reason")
    .notEmpty()
    .withMessage("Reason is required")
    .isString()
    .withMessage("Reason must be a string")
    .trim()
    .isLength({ min: 10, max: 500 })
    .withMessage("Reason must be between 10 and 500 characters"),
  validatorMiddleware,
];

export const getReturnRequestValidator = [
  param("returnId").isMongoId().withMessage("Invalid return request ID"),
  validatorMiddleware,
];

export const listReturnRequestsValidator = [
  query("status")
    .optional()
    .isIn(Object.values(returnStatusEnum))
    .withMessage("Invalid status"),
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("Page must be a positive integer"),
  query("limit")
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage("Limit must be between 1 and 100"),
  validatorMiddleware,
];

export const processReturnRequestValidator = [
  param("returnId").isMongoId().withMessage("Invalid return request ID"),
  body("status")
    .notEmpty()
    .trim()
    .toLowerCase()
    .withMessage("Status is required")
    .isIn([returnStatusEnum.APPROVED, returnStatusEnum.REJECTED])
    .withMessage("Status must be approved or rejected"),
  body("rejectionReason")
    .if(body("status").equals(returnStatusEnum.REJECTED))
    .notEmpty()
    .withMessage("Rejection reason is required when rejecting")
    .isString()
    .withMessage("Rejection reason must be a string")
    .trim()
    .isLength({ max: 500 })
    .withMessage("Rejection reason cannot exceed 500 characters"),
  validatorMiddleware,
];
