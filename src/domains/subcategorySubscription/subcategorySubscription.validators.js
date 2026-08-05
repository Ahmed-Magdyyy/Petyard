import { param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const subcategoryIdParamValidator = [
  param("subcategoryId")
    .notEmpty()
    .withMessage("subcategoryId is required")
    .isMongoId()
    .withMessage("subcategoryId must be a valid MongoDB ObjectId"),
  validatorMiddleware,
];
