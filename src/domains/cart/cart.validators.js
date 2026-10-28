import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";
import { normalizeProductType } from "../../shared/utils/productType.js";
import { productTypeEnum } from "../../shared/constants/enums.js";

const directBundleFields = allowed => body().custom(value => {
  if (value == null) return allowed.length === 0;
  return value.constructor === Object && Object.keys(value).every(key => allowed.includes(key));
}).withMessage("Unexpected bundle cart request fields");
const bundleQuantity = body("quantity").custom(value => Number.isSafeInteger(value) && value > 0)
  .withMessage("quantity must be a positive safe integer");

export const upsertCartBundleValidator = [
  directBundleFields(["bundleId", "expectedRevision", "quantity"]),
  body("bundleId").isString().isMongoId().withMessage("bundleId must be a valid id"),
  body("expectedRevision").custom(value => Number.isSafeInteger(value) && value > 0)
    .withMessage("expectedRevision must be a positive safe integer"),
  bundleQuantity, validatorMiddleware,
];
export const cartBundleIdValidator = [param("groupId").isMongoId().withMessage("Invalid cart bundle id"), validatorMiddleware];
export const updateCartBundleValidator = [directBundleFields(["quantity"]), bundleQuantity, validatorMiddleware];
export const emptyBundleCartBodyValidator = [directBundleFields([]), validatorMiddleware];

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
  body("warehouseId").optional().isString().isMongoId().withMessage("warehouseId must be a valid id"),
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
