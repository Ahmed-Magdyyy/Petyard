import { body, param, query } from "express-validator";
import { validatorMiddleware } from "../../../shared/middlewares/validatorMiddleware.js";

export const createServiceLocationValidator = [
  body("slug").optional().isString().withMessage("slug must be a string"),

  body("name_en")
    .notEmpty()
    .withMessage("name_en is required")
    .isString()
    .withMessage("name_en must be a string"),

  body("name_ar")
    .optional()
    .isString()
    .withMessage("name_ar must be a string"),

  body("city")
    .notEmpty()
    .withMessage("city is required")
    .isString()
    .withMessage("city must be a string"),

  body("timezone")
    .optional()
    .isString()
    .withMessage("timezone must be a string"),

  body("googleMapsLink")
    .optional()
    .isString()
    .withMessage("googleMapsLink must be a string"),

  body("email").optional().isEmail().withMessage("email must be a valid email"),

  body("phone").optional().isString().withMessage("phone must be a string"),

  body("active").optional().isBoolean().withMessage("active must be a boolean"),

  body("capacityByRoomType").notEmpty().withMessage("capacityByRoomType is required"),

  body("capacityByRoomType.groomingRoom")
    .notEmpty()
    .withMessage("capacityByRoomType.groomingRoom is required")
    .isInt({ min: 0 })
    .withMessage("capacityByRoomType.groomingRoom must be >= 0"),

  body("capacityByRoomType.clinicRoom")
    .notEmpty()
    .withMessage("capacityByRoomType.clinicRoom is required")
    .isInt({ min: 0 })
    .withMessage("capacityByRoomType.clinicRoom must be >= 0"),

  validatorMiddleware,
];

export const updateServiceLocationValidator = [
  param("id").isMongoId().withMessage("Invalid location id"),

  body("slug").optional().isString().withMessage("slug must be a string"),

  body("name_en").optional().isString().withMessage("name_en must be a string"),
  body("name_ar").optional().isString().withMessage("name_ar must be a string"),

  body("city").optional().isString().withMessage("city must be a string"),
  body("timezone")
    .optional()
    .isString()
    .withMessage("timezone must be a string"),

  body("googleMapsLink")
    .optional()
    .isString()
    .withMessage("googleMapsLink must be a string"),

  body("email").optional().isEmail().withMessage("email must be a valid email"),

  body("phone").optional().isString().withMessage("phone must be a string"),

  body("active").optional().isBoolean().withMessage("active must be a boolean"),

  body("capacityByRoomType").optional().isObject().withMessage("capacityByRoomType must be an object"),

  body("capacityByRoomType.groomingRoom")
    .optional()
    .isInt({ min: 0 })
    .withMessage("capacityByRoomType.groomingRoom must be >= 0"),

  body("capacityByRoomType.clinicRoom")
    .optional()
    .isInt({ min: 0 })
    .withMessage("capacityByRoomType.clinicRoom must be >= 0"),

  validatorMiddleware,
];

export const serviceLocationIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid location id"),
  validatorMiddleware,
];

export const adminListServiceLocationsQueryValidator = [
  query("includeInactive")
    .optional()
    .isBoolean()
    .withMessage("includeInactive must be boolean"),
  validatorMiddleware,
];
