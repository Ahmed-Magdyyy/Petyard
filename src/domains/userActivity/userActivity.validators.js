// src/domains/userActivity/userActivity.validators.js
import { param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const getUserActivityValidator = [
  param("id").isMongoId().withMessage("Invalid user id"),

  validatorMiddleware,
];
