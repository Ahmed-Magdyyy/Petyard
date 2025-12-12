import { body, header } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const addToFavoriteValidator = [
  body("productId")
    .notEmpty()
    .withMessage("productId is required")
    .isMongoId()
    .withMessage("productId must be a valid MongoDB ObjectId"),

  validatorMiddleware,
];

export const removeFromFavoriteValidator = [
  body("productId")
    .notEmpty()
    .withMessage("productId is required")
    .isMongoId()
    .withMessage("productId must be a valid MongoDB ObjectId"),

  validatorMiddleware,
];

export const guestFavoriteHeaderValidator = [
  header("x-guest-id")
    .notEmpty()
    .withMessage("x-guest-id header is required")
    .isString()
    .withMessage("x-guest-id header must be a string"),

  validatorMiddleware,
];

export const addToFavoriteGuestValidator = [
  header("x-guest-id")
    .notEmpty()
    .withMessage("x-guest-id header is required")
    .isString()
    .withMessage("x-guest-id header must be a string"),

  body("productId")
    .notEmpty()
    .withMessage("productId is required")
    .isMongoId()
    .withMessage("productId must be a valid MongoDB ObjectId"),

  validatorMiddleware,
];

export const removeFromFavoriteGuestValidator = [
  header("x-guest-id")
    .notEmpty()
    .withMessage("x-guest-id header is required")
    .isString()
    .withMessage("x-guest-id header must be a string"),

  body("productId")
    .notEmpty()
    .withMessage("productId is required")
    .isMongoId()
    .withMessage("productId must be a valid MongoDB ObjectId"),

  validatorMiddleware,
];
