import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

const addressFields = [
  body("label")
    .optional({ nullable: true })
    .isString()
    .withMessage("label must be a string"),

  body("name").notEmpty().withMessage("name is required"),

  body("governorate").notEmpty().withMessage("governorate is required"),

  body("area").optional().isString().withMessage("area must be a string"),

  body("details").notEmpty().withMessage("details is required"),

  body("phone").notEmpty().withMessage("phone is required"),

  body("building")
    .notEmpty()
    .withMessage("Building is required")
    .isString()
    .withMessage("Building must be a string"),

  body("floor")
    .notEmpty()
    .withMessage("Floor is required")
    .isString()
    .withMessage("Floor must be a string"),

  body("apartment")
    .notEmpty()
    .withMessage("Apartment number is required")
    .isString()
    .withMessage("Apartment number must be a string"),

  body("location.lat")
    .notEmpty()
    .withMessage("location.lat is required")
    .isFloat()
    .withMessage("location.lat must be a number"),

  body("location.lng")
    .notEmpty()
    .withMessage("location.lng is required")
    .isFloat()
    .withMessage("location.lng must be a number"),

  body("isDefault")
    .optional()
    .isBoolean()
    .withMessage("isDefault must be a boolean"),
];

const addressFieldsOptional = [
  body("label")
    .optional({ nullable: true })
    .isString()
    .withMessage("label must be a string"),

  body("name").optional().notEmpty().withMessage("name must not be empty"),

  body("governorate")
    .optional()
    .notEmpty()
    .withMessage("governorate must not be empty"),

  body("area").optional().notEmpty().withMessage("area must not be empty"),

  body("details")
    .optional()
    .notEmpty()
    .withMessage("details must not be empty"),

  body("phone").optional().notEmpty().withMessage("phone must not be empty"),

  body("building")
    .optional()
    .notEmpty()
    .withMessage("Building must not be empty")
    .isString()
    .withMessage("Building must be a string"),

  body("floor")
    .optional()
    .notEmpty()
    .withMessage("Floor must not be empty")
    .isString()
    .withMessage("Floor must be a string"),

  body("apartment")
    .optional()
    .notEmpty()
    .withMessage("Apartment number must not be empty")
    .isString()
    .withMessage("Apartment number must be a string"),

  body("location.lat")
    .optional({ nullable: true })
    .isFloat()
    .withMessage("location.lat must be a number"),

  body("location.lng")
    .optional({ nullable: true })
    .isFloat()
    .withMessage("location.lng must be a number"),

  body("isDefault")
    .optional()
    .isBoolean()
    .withMessage("isDefault must be a boolean"),
];

export const addressIdParamValidator = [
  param("addressId").isMongoId().withMessage("Invalid address ID"),
  validatorMiddleware,
];

export const addAddressValidator = [...addressFields, validatorMiddleware];

export const updateAddressValidator = [
  ...addressIdParamValidator.slice(0, -1), // param rule without middleware
  ...addressFieldsOptional,
  validatorMiddleware,
];

export const deleteAddressValidator = addressIdParamValidator;

export const setDefaultAddressValidator = addressIdParamValidator;
