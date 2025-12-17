import { body } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const updateLoyaltySettingsValidator = [
  body("pointsEarnRate")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("Points earn rate must be a positive number"),
  body("pointsRedeemRate")
    .optional()
    .isFloat({ min: 1 })
    .withMessage("Points redeem rate must be at least 1"),
  body("minPointsToRedeem")
    .optional()
    .isInt({ min: 0 })
    .withMessage("Minimum points to redeem must be a positive integer"),
  body("isActive")
    .optional()
    .isBoolean()
    .withMessage("isActive must be a boolean"),
  validatorMiddleware,
];
