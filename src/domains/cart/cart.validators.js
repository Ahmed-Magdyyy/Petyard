import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";
import { normalizeProductType } from "../../shared/utils/productType.js";
import { productTypeEnum } from "../../shared/constants/enums.js";

export const warehouseIdParamValidator = [
  param("warehouseId").isMongoId().withMessage("Invalid warehouse id"),
  validatorMiddleware,
];

export const cartItemIdParamValidator = [
  param("itemId").isMongoId().withMessage("Invalid cart item id"),
  validatorMiddleware,
];

export const upsertCartItemValidator = [
  body("productId")
    .notEmpty()
    .withMessage("productId is required")
    .isMongoId()
    .withMessage("productId must be a valid id"),

  body("productType")
    .notEmpty()
    .withMessage("productType is required")
    .customSanitizer((value) => normalizeProductType(value))
    .isIn(Object.values(productTypeEnum))
    .withMessage("productType must be either SIMPLE or VARIANT"),

  body("quantity")
    .notEmpty()
    .withMessage("quantity is required")
    .isInt({ min: 1 })
    .withMessage("quantity must be at least 1"),

  body("variantId")
    .if(body("productType").equals(productTypeEnum.VARIANT))
    .notEmpty()
    .withMessage("variantId is required for VARIANT products")
    .isMongoId()
    .withMessage("variantId must be a valid id"),

  validatorMiddleware,
];

export const updateCartItemQuantityValidator = [
  body("quantity")
    .notEmpty()
    .withMessage("quantity is required")
    .isInt({ min: 1 })
    .withMessage("quantity must be at least 1"),

  validatorMiddleware,
];

export const setUserCartAddressValidator = [
  body("userAddressId")
    .notEmpty()
    .withMessage("userAddressId is required")
    .isMongoId()
    .withMessage("userAddressId must be a valid id"),

  validatorMiddleware,
];

export const setGuestCartAddressValidator = [
  body("guestAddressId")
    .notEmpty()
    .withMessage("guestAddressId is required")
    .isMongoId()
    .withMessage("guestAddressId must be a valid id"),

  validatorMiddleware,
];
