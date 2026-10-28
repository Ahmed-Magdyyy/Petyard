import { body, checkExact, param, query } from "express-validator";
import { assistantValidatorMiddleware } from "../shared/assistant.validators.js";
import { referenceMetadata } from "./assistant.reference-service.js";

const id = () => param("referenceId").isString().bail().isMongoId();
export const referenceUploadValidator = [
  body().custom(value => Boolean(referenceMetadata(value))), assistantValidatorMiddleware,
];
export const referenceEmptyQueryValidator = [checkExact([], { locations: ["query"] }), assistantValidatorMiddleware];
export const referenceIdValidator = [id(), ...referenceEmptyQueryValidator];
export const referenceListValidator = [checkExact([
  query("before").optional().isString().bail().isMongoId(),
  query("limit").optional().isString().bail().matches(/^[1-9]\d{0,2}$/).bail().isInt({ min: 1, max: 100 }),
], { locations: ["query"] }), assistantValidatorMiddleware];
export const referenceVersionValidator = [id(), checkExact([
  body("expectedVersion").custom(value => Number.isSafeInteger(value) && value > 0),
], { locations: ["body"] }), checkExact([], { locations: ["query"] }), assistantValidatorMiddleware];
