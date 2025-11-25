// src/domains/location/location.validators.js
import { body } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const resolveLocationValidator = [
  body("lat")
    .notEmpty()
    .withMessage("lat is required")
    .isFloat({ min: -90, max: 90 })
    .withMessage("lat must be a valid latitude"),

  body("lng")
    .notEmpty()
    .withMessage("lng is required")
    .isFloat({ min: -180, max: 180 })
    .withMessage("lng must be a valid longitude"),

  body("governorateRaw")
    .optional()
    .isString()
    .withMessage("governorateRaw must be a string"),

  body("source")
    .optional()
    .isIn(["gps", "manual"])
    .withMessage("source must be 'gps' or 'manual'"),

  validatorMiddleware,
];
