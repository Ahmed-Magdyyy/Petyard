import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const createReviewValidator = [
  body("rating")
    .notEmpty()
    .withMessage("rating is required")
    .isInt({ min: 1, max: 5 })
    .withMessage("rating must be between 1 and 5"),

  body("comment")
    .optional()
    .isString()
    .withMessage("comment must be a string"),

  validatorMiddleware,
];

export const reviewIdParamValidator = [
  param("reviewId").isMongoId().withMessage("Invalid review id"),

  validatorMiddleware,
];