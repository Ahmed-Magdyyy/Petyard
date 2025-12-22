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
    .toUpperCase()
    .isIn(Object.values(serviceTypeEnum))
    .withMessage("Invalid serviceType"),

  query("date")
    .notEmpty()
    .withMessage("date is required")
    .isISO8601({ strict: true })
    .withMessage("date must be a valid ISO date"),

  validatorMiddleware,
];

export const adminUpdateReservationStatusValidator = [
  param("id").isMongoId().withMessage("Invalid reservation id"),

  body("status")
    .notEmpty()
    .withMessage("status is required")
    .toUpperCase()
    .isIn(Object.values(serviceReservationStatusEnum))
    .withMessage("Invalid status"),

  validatorMiddleware,
];

export const adminListReservationsByDateQueryValidator = [
  query("date")
    .notEmpty()
    .withMessage("date is required")
    .isISO8601({ strict: true })
    .withMessage("date must be a valid ISO date"),

  query("locationId")
    .optional()
    .isMongoId()
    .withMessage("locationId must be a valid id"),

  query("status")
    .optional()
    .toUpperCase()
    .isIn(Object.values(serviceReservationStatusEnum))
    .withMessage("Invalid status"),

  validatorMiddleware,
];

export const createReservationValidator = [
  body("locationId")
    .notEmpty()
    .withMessage("locationId is required")
    .isMongoId()
    .withMessage("locationId must be a valid id"),

  body("serviceType")
    .optional()
    .toUpperCase()
    .isIn(Object.values(serviceTypeEnum))
    .withMessage("Invalid serviceType"),

  body("services")
    .optional()
    .isArray({ min: 1 })
    .withMessage("services must be a non-empty array"),

  body("services.*.serviceType")
    .notEmpty()
    .withMessage("services[].serviceType is required")
    .toUpperCase()
    .isIn(Object.values(serviceTypeEnum))
    .withMessage("Invalid services[].serviceType"),

  body("services.*.serviceOptionKey")
    .optional()
    .isString()
    .withMessage("services[].serviceOptionKey must be a string"),

  body("serviceOptionKey")
    .optional()
    .isString()
    .withMessage("serviceOptionKey must be a string"),

  body().custom((_, { req }) => {
    const hasServiceType =
      req.body.serviceType !== undefined &&
      req.body.serviceType !== null &&
      String(req.body.serviceType).trim() !== "";

    const services = req.body.services;
    const hasServicesArray = Array.isArray(services) && services.length > 0;

    if (hasServiceType || hasServicesArray) return true;

    throw new Error("Either serviceType or services[] is required");
  }),

  body().custom((_, { req }) => {
    if (!Array.isArray(req.body.services)) return true;

    for (let i = 0; i < req.body.services.length; i += 1) {
      const item = req.body.services[i];
      if (!item || typeof item !== "object") {
        throw new Error(`services[${i}] must be an object`);
      }
      if (
        item.serviceType === undefined ||
        item.serviceType === null ||
        String(item.serviceType).trim() === ""
      ) {
        throw new Error(`services[${i}].serviceType is required`);
      }
    }

    return true;
  }),

  body("date")
    .notEmpty()
    .withMessage("date is required")
    .isISO8601({ strict: true })
    .withMessage("date must be a valid ISO date"),

  body("hour24")
    .optional()
    .isInt({ min: 0, max: 23 })
    .withMessage("hour24 must be an integer between 0 and 23"),

  body("hour12")
    .optional()
    .isInt({ min: 1, max: 12 })
    .withMessage("hour12 must be an integer between 1 and 12"),

  body("ampm")
    .optional()
    .isIn(["AM", "PM", "am", "pm"])
    .withMessage("ampm must be AM or PM"),

  body().custom((_, { req }) => {
    const hasHour24 =
      req.body.hour24 !== undefined &&
      req.body.hour24 !== null &&
      String(req.body.hour24).trim() !== "";
    const hasHour12 =
      req.body.hour12 !== undefined &&
      req.body.hour12 !== null &&
      String(req.body.hour12).trim() !== "";
    const hasAmpm =
      req.body.ampm !== undefined &&
      req.body.ampm !== null &&
      String(req.body.ampm).trim() !== "";

    if (hasHour24) return true;
    if (hasHour12 && hasAmpm) return true;
    throw new Error("Either hour24 or (hour12 and ampm) is required");
  }),

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
    .toUpperCase()
    .isIn(Object.values(serviceReservationStatusEnum))
    .withMessage("Invalid status"),

  validatorMiddleware,
];
