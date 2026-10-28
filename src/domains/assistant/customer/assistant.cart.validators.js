import { body, checkExact, header, param } from "express-validator";
import { assistantValidatorMiddleware } from "../shared/assistant.validators.js";

const identifier = (chain) => chain.isString().bail().isMongoId();

export const prepareCartProposalValidator = [
  checkExact([
    identifier(body("sourceMessageId")).custom((_value, { req }) => {
      const value = req.body;
      return Object.hasOwn(value, "bundleId")
        ? !Object.hasOwn(value, "productId") && !Object.hasOwn(value, "variantId") && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 1
        : Object.hasOwn(value, "productId") && !Object.hasOwn(value, "expectedRevision");
    }),
    identifier(body("warehouseId")),
    identifier(body("productId").optional()),
    identifier(body("bundleId").optional()),
    body("expectedRevision").optional().custom((value) => Number.isSafeInteger(value) && value >= 1),
    identifier(body("variantId").optional({ values: "null" })),
    body("quantity").custom((value) => Number.isSafeInteger(value) && value >= 1),
    body("language").isString().bail().isIn(["ar", "en"]),
  ], { locations: ["body"] }),
  header("Idempotency-Key").isString().bail().matches(/^[a-zA-Z0-9._:-]{8,128}$/),
  assistantValidatorMiddleware,
];

export const cartProposalIdValidator = [identifier(param("proposalId")), assistantValidatorMiddleware];

export const confirmCartProposalValidator = [
  ...cartProposalIdValidator,
  checkExact([
    body("expectedVersion").custom((value) => value === 1),
    body("fingerprint").isString().bail().matches(/^[a-f\d]{64}$/),
    identifier(body("warehouseId").optional()),
  ], { locations: ["body"] }),
  assistantValidatorMiddleware,
];
