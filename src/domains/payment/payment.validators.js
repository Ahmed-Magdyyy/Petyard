import { param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const savedCardIdValidator = [
  param("id").isMongoId().withMessage("Invalid card id"),
  validatorMiddleware,
];
