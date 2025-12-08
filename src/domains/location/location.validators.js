// src/domains/location/location.validators.js
import { body } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const resolveLocationValidator = [
  body("lat")
    .optional()
    .isFloat({ min: -90, max: 90 })
    .withMessage("lat must be a valid latitude"),

  body("lng")
    .optional()
    .isFloat({ min: -180, max: 180 })
    .withMessage("lng must be a valid longitude"),

  body("governorateCode")
    .optional()
    .isString()
    .withMessage("governorateCode must be a string"),

  body("areaCode")
    .optional()
    .isString()
    .withMessage("areaCode must be a string"),

  validatorMiddleware,
];
