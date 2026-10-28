import { checkExact, query } from "express-validator";
import { assistantValidatorMiddleware } from "../shared/assistant.validators.js";

export const checkoutSummaryValidator = [
  checkExact([
    query("warehouseId").isString().bail().isMongoId().withMessage("A valid warehouseId is required"),
    query("language").isString().bail().isIn(["en", "ar"]).withMessage("language must be en or ar"),
  ], { locations: ["query"] }),
  assistantValidatorMiddleware,
];
