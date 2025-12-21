import { body, param, query } from "express-validator";
import {
  serviceReservationStatusEnum,
  serviceTypeEnum,
} from "../../../shared/constants/enums.js";
import { validatorMiddleware } from "../../../shared/middlewares/validatorMiddleware.js";

export const availabilityQueryValidator = [
  query("locationId")
    .notEmpty()
    .withMessage("locationId is required")
    .isMongoId()
    .withMessage("locationId must be a valid id"),

  query("serviceType")
    .notEmpty()
    .withMessage("serviceType is required")
    .isIn(Object.values(serviceTypeEnum))
    .withMessage("Invalid serviceType"),

  query("date")
    .notEmpty()
    .withMessage("date is required")
    .isISO8601({ strict: true })
    .withMessage("date must be a valid ISO date"),

  validatorMiddleware,
];

export const createReservationValidator = [
  body("locationId")
    .notEmpty()
    .withMessage("locationId is required")
    .isMongoId()
    .withMessage("locationId must be a valid id"),

  body("serviceType")
    .notEmpty()
    .withMessage("serviceType is required")
    .isIn(Object.values(serviceTypeEnum))
    .withMessage("Invalid serviceType"),

  body("serviceOptionKey")
    .optional()
    .isString()
    .withMessage("serviceOptionKey must be a string"),

  body("date")
    .notEmpty()
    .withMessage("date is required")
    .isISO8601({ strict: true })
    .withMessage("date must be a valid ISO date"),

  body("hour12")
    .notEmpty()
    .withMessage("hour12 is required")
    .isInt({ min: 1, max: 12 })
    .withMessage("hour12 must be an integer between 1 and 12"),

  body("ampm")
    .notEmpty()
    .withMessage("ampm is required")
    .isIn(["AM", "PM", "am", "pm"])
    .withMessage("ampm must be AM or PM"),

  body("petId").optional().isMongoId().withMessage("petId must be a valid id"),

  body("ownerName").optional().isString().withMessage("ownerName must be a string"),
  body("ownerPhone")
    .optional()
    .isString()
    .withMessage("ownerPhone must be a string"),

  body("petType").optional().isString().withMessage("petType must be a string"),
  body("petName").optional().isString().withMessage("petName must be a string"),

  body("age")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("age must be a non-negative number"),

  body("gender").optional().isString().withMessage("gender must be a string"),
  body("comment").optional().isString().withMessage("comment must be a string"),

  validatorMiddleware,
];

export const reservationIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid reservation id"),
  validatorMiddleware,
];

export const listReservationsQueryValidator = [
  query("scope")
    .optional()
    .isIn(["upcoming", "past", "all"])
    .withMessage("scope must be upcoming, past, or all"),

  query("status")
    .optional()
    .isIn(Object.values(serviceReservationStatusEnum))
    .withMessage("Invalid status"),

  validatorMiddleware,
];
