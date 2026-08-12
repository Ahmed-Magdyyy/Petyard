import { body, param, query } from 'express-validator';
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const subcategoryIdParamValidator = [
  param("subcategoryId")
    .notEmpty()
    .withMessage("subcategoryId is required")
    .isMongoId()
    .withMessage("subcategoryId must be a valid MongoDB ObjectId"),
  validatorMiddleware,
];

export const warehouseIdBodyValidator = [
  body('warehouseId')
    .optional()
    .isMongoId()
    .withMessage('warehouseId must be a valid MongoDB ObjectId'),
  validatorMiddleware,
];

export const warehouseQueryValidator = [
  query('warehouse')
    .optional()
    .isMongoId()
    .withMessage('warehouse must be a valid MongoDB ObjectId'),
  validatorMiddleware,
];

export const demandQueryValidator = [
  ...warehouseQueryValidator.slice(0, -1),
  query('search').optional().isString().trim(),
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('page must be a positive integer')
    .toInt(),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('limit must be a positive integer no greater than 100')
    .toInt(),
  validatorMiddleware,
];

export const demandSubscribersQueryValidator = [
  ...subcategoryIdParamValidator.slice(0, -1),
  ...warehouseQueryValidator.slice(0, -1),
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('page must be a positive integer')
    .toInt(),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('limit must be a positive integer no greater than 100')
    .toInt(),
  validatorMiddleware,
];
