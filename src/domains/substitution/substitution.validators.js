import { body, header, param, query } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { SUBSTITUTION_EXPIRY_PRESETS } from "./substitution.config.js";

export function parseSubstitutionJsonFields(req, res, next) {
  for (const field of ["shortages", "selections"]) {
    if (typeof req.body?.[field] !== "string") continue;
    try {
      req.body[field] = JSON.parse(req.body[field]);
    } catch {
      return next(new ApiError(`${field} must be valid JSON`, 400));
    }
  }
  return next();
}

const idempotencyHeader = header("idempotency-key")
  .isString()
  .trim()
  .isLength({ min: 8, max: 128 })
  .withMessage("Idempotency-Key must contain 8 to 128 characters");

export const substitutionOrderIdValidator = [
  param("id").isMongoId().withMessage("Invalid order id"),
  validatorMiddleware,
];

export const substitutionRequestParamsValidator = [
  param("id").isMongoId().withMessage("Invalid order id"),
  param("requestId").isMongoId().withMessage("Invalid substitution request id"),
  validatorMiddleware,
];

export const substitutionCandidatesValidator = [
  param("id").isMongoId().withMessage("Invalid order id"),
  query("lineId").isString().trim().notEmpty().withMessage("lineId is required"),
  query("q").optional().isString().trim().isLength({ max: 100 }),
  query("page").optional().isInt({ min: 1 }),
  query("limit").optional().isInt({ min: 1, max: 50 }),
  validatorMiddleware,
];

export const createSubstitutionValidator = [
  param("id").isMongoId().withMessage("Invalid order id"),
  idempotencyHeader,
  body("expiresInMinutes")
    .optional()
    .isInt()
    .custom((value) => SUBSTITUTION_EXPIRY_PRESETS.includes(Number(value)))
    .withMessage("expiresInMinutes must be 5, 10, 15, 30, 60, or 120")
    .toInt(),
  body("originalInstapayVerified").optional().isBoolean().toBoolean(),
  body("shortages").isArray({ min: 1 }).withMessage("shortages are required"),
  body("shortages.*.lineId").isString().trim().notEmpty(),
  body("shortages.*.deliverableOriginalQuantity").isInt({ min: 0 }).toInt(),
  body("shortages.*.expectedUnallocatedQuantity").isInt({ min: 0 }).toInt(),
  body("shortages.*.expectedStockRevision").isInt({ min: 0 }).toInt(),
  body("shortages.*.correctedUnallocatedQuantity").isInt({ min: 0 }).toInt(),
  body("shortages.*.correctionReason")
    .optional()
    .equals("offline_sale")
    .withMessage("correctionReason must be offline_sale"),
  body("shortages.*.note")
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 500 }),
  body("shortages.*.alternatives").isArray(),
  body("shortages.*.alternatives.*.productId").isMongoId(),
  body("shortages.*.alternatives.*.variantId")
    .optional({ nullable: true })
    .isMongoId(),
  body("shortages.*.alternatives.*.maxQuantity").isInt({ min: 1 }).toInt(),
  validatorMiddleware,
];

const selectionValidators = [
  body("requestRevision").isInt({ min: 0 }).toInt(),
  body("selections").isArray({ min: 1 }),
  body("selections.*.shortageId").isString().trim().notEmpty(),
  body("selections.*.choices").isArray(),
  body("selections.*.choices.*.candidateId").isString().trim().notEmpty(),
  body("selections.*.choices.*.quantity").isInt({ min: 1 }).toInt(),
];

export const quoteSubstitutionValidator = [
  param("id").isMongoId(),
  param("requestId").isMongoId(),
  ...selectionValidators,
  validatorMiddleware,
];

export const respondToSubstitutionValidator = [
  param("id").isMongoId(),
  param("requestId").isMongoId(),
  idempotencyHeader,
  ...selectionValidators,
  body("quoteRevision").isString().trim().notEmpty(),
  body("quotedWalletBalancePiastres").optional().isInt({ min: 0 }).toInt(),
  body("savedCardId").optional({ nullable: true }).isMongoId(),
  validatorMiddleware,
];

export const retrySubstitutionPaymentValidator = [
  param("id").isMongoId(),
  param("requestId").isMongoId(),
  param("attemptId").isMongoId(),
  idempotencyHeader,
  body("savedCardId").optional({ nullable: true }).isMongoId(),
  validatorMiddleware,
];
