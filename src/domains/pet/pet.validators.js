// src/domains/pet/pet.validators.js
import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

const petTypes = ["dog", "cat", "other"];
const genders = ["male", "female", "unknown"];

function conditionArrayValidators(fieldName) {
  return [
    body(fieldName)
      .optional()
      .isArray()
      .withMessage(`${fieldName} must be an array of slugs`),
    body(`${fieldName}.*`)
      .optional()
      .isString()
      .withMessage(`${fieldName} entries must be strings`),
  ];
}

export const createPetValidator = [
  body("name").notEmpty().withMessage("name is required"),

  body("type")
    .notEmpty()
    .withMessage("type is required")
    .isIn(petTypes)
    .withMessage(`type must be one of: ${petTypes.join(", ")}`),

  body("breed")
    .optional()
    .isString()
    .withMessage("breed must be a string"),

  body("gender")
    .optional()
    .isIn(genders)
    .withMessage(`gender must be one of: ${genders.join(", ")}`),

  body("birthDate")
    .optional()
    .isISO8601()
    .withMessage("birthDate must be a valid ISO 8601 date"),

  ...conditionArrayValidators("chronic_conditions"),
  ...conditionArrayValidators("temp_health_issues"),

  validatorMiddleware,
];

export const updatePetValidator = [
  param("id").isMongoId().withMessage("Invalid pet id"),

  body("name")
    .optional()
    .isString()
    .withMessage("name must be a string"),

  body("type")
    .optional()
    .isIn(petTypes)
    .withMessage(`type must be one of: ${petTypes.join(", ")}`),

  body("breed")
    .optional()
    .isString()
    .withMessage("breed must be a string"),

  body("gender")
    .optional()
    .isIn(genders)
    .withMessage(`gender must be one of: ${genders.join(", ")}`),

  body("birthDate")
    .optional()
    .isISO8601()
    .withMessage("birthDate must be a valid ISO 8601 date"),

  ...conditionArrayValidators("chronic_conditions"),
  ...conditionArrayValidators("temp_health_issues"),

  validatorMiddleware,
];

export const petIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid pet id"),

  validatorMiddleware,
];

export const petUserIdParamValidator = [
  param("userId").isMongoId().withMessage("Invalid user id"),

  validatorMiddleware,
];
