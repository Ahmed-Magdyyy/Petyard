import { body, param, query } from "express-validator";
import { validatorMiddleware } from "../../../shared/middlewares/validatorMiddleware.js";

export const reservationIdParamValidator = [
  param("reservationId")
    .isMongoId()
    .withMessage("Invalid reservation id"),

  validatorMiddleware,
];

export const locationIdParamValidator = [
  param("locationId")
    .isMongoId()
    .withMessage("Invalid location id"),

  validatorMiddleware,
];

export const createReviewValidator = [
  body("rating")
    .notEmpty()
    .withMessage("rating is required")
    .isInt({ min: 1, max: 5 })
    .withMessage("rating must be between 1 and 5"),

  body("comment")
    .optional()
    .isString()
    .withMessage("comment must be a string")
    .isLength({ max: 250 })
    .withMessage("comment must be at most 250 characters"),

  validatorMiddleware,
];

export const listReviewsQueryValidator = [
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("page must be a positive integer"),

  query("limit")
    .optional()
    .isInt({ min: 1, max: 50 })
    .withMessage("limit must be between 1 and 50"),

  query("serviceType")
    .optional()
    .isString()
    .withMessage("serviceType must be a string"),

  validatorMiddleware,
];
