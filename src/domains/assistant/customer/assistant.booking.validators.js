import { body, checkExact, header, param, query } from "express-validator";
import { assistantValidatorMiddleware } from "../shared/assistant.validators.js";
import { bookingPreviewValidator, bookingLocationValidator } from "./assistant.booking-reads.validators.js";

export const prepareBookingReviewValidator = [...bookingPreviewValidator,
  header("Idempotency-Key").isString().bail().matches(/^[a-zA-Z0-9._:-]{8,128}$/), assistantValidatorMiddleware];
const identifier = () => param("proposalId").isString().bail().isMongoId();
const noQuery = () => query().custom(value => Object.keys(value).length === 0);
export const bookingReviewIdValidator = [checkExact([identifier(), noQuery(),
  body().custom(value => value == null || value.constructor === Object && Object.keys(value).length === 0)],
{ locations: ["params", "query", "body"] }), assistantValidatorMiddleware];
export const confirmBookingReviewValidator = [checkExact([identifier(), noQuery(), bookingLocationValidator(),
  body("expectedVersion").custom(value => value === 1), body("fingerprint").isString().bail().matches(/^[a-f\d]{64}$/)],
{ locations: ["params", "query", "body"] }), assistantValidatorMiddleware];
