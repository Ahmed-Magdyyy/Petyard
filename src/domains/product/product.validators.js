import { body, param, query } from "express-validator";
import validator from "validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";
import { normalizeProductType } from "../../shared/utils/productType.js";
import { productTypeEnum } from "../../shared/constants/enums.js";

export const createProductValidator = [
  body("type")
    .notEmpty()
    .withMessage("type is required")
    .customSanitizer((value) => normalizeProductType(value))
    .isIn(Object.values(productTypeEnum))
    .withMessage("type must be either SIMPLE or VARIANT"),

  body("subcategory")
    .notEmpty()
    .withMessage("subcategory is required")
    .isMongoId()
    .withMessage("subcategory must be a valid id"),

  body("brand")
    .optional({ nullable: true })
    .isMongoId()
    .withMessage("brand must be a valid id"),

  body("name_en").notEmpty().withMessage("English name is required"),
  body("name_ar").notEmpty().withMessage("Arabic name is required"),

  body("desc_en").notEmpty().withMessage("English description is required"),
  body("desc_ar").notEmpty().withMessage("Arabic description is required"),

  body("tags").optional().isArray().withMessage("tags must be an array"),

  body("tags.*").optional().isString().withMessage("each tag must be a string"),

  body("options").optional().isArray().withMessage("options must be an array"),

  body("options.*.name")
    .optional()
    .isString()
    .withMessage("options.*.name must be a string"),

  body("options.*.values")
    .optional()
    .isArray()
    .withMessage("options.*.values must be an array"),

  body("options.*.values.*")
    .optional()
    .isString()
    .withMessage("each option value must be a string"),

  body("options").optional().isArray().withMessage("options must be an array"),

  body("options.*.name")
    .optional()
    .isString()
    .withMessage("options.*.name must be a string"),

  body("options.*.values")
    .optional()
    .isArray()
    .withMessage("options.*.values must be an array"),

  body("options.*.values.*")
    .optional()
    .isString()
    .withMessage("each option value must be a string"),

  body("warehouseStocks")
    .optional()
    .isArray()
    .withMessage("warehouseStocks must be an array"),

  body("warehouseStocks.*.warehouse")
    .optional()
    .isMongoId()
    .withMessage("warehouseStocks.*.warehouse must be a valid id"),

  body("warehouseStocks.*.quantity")
    .optional()
    .isNumeric()
    .withMessage("warehouseStocks.*.quantity must be a number"),

  body("variants")
    .optional()
    .isArray()
    .withMessage("variants must be an array"),

  body("variants.*.price")
    .optional()
    .isNumeric()
    .withMessage("variant price must be a number"),

  body("variants.*.discountedPrice")
    .optional()
    .isNumeric()
    .withMessage("variant discountedPrice must be a number"),

  body("variants.*.options")
    .optional()
    .isArray()
    .withMessage("variant options must be an array"),

  body("variants.*.options.*.name")
    .optional()
    .isString()
    .withMessage("variant option name must be a string"),

  body("variants.*.options.*.value")
    .optional()
    .isString()
    .withMessage("variant option value must be a string"),

  body("variants.*.warehouseStocks")
    .optional()
    .isArray()
    .withMessage("variant warehouseStocks must be an array"),

  body("variants.*.warehouseStocks.*.warehouse")
    .optional()
    .isMongoId()
    .withMessage("variant warehouseStocks.*.warehouse must be a valid id"),

  body("variants.*.warehouseStocks.*.quantity")
    .optional()
    .isNumeric()
    .withMessage("variant warehouseStocks.*.quantity must be a number"),

  body("variants.*.options")
    .optional()
    .isArray()
    .withMessage("variant options must be an array"),

  body("variants.*.options.*.name")
    .optional()
    .isString()
    .withMessage("variant option name must be a string"),

  body("variants.*.options.*.value")
    .optional()
    .isString()
    .withMessage("variant option value must be a string"),

  body("type").custom((value, { req }) => {
    if (value === productTypeEnum.SIMPLE) {
      if (
        !Array.isArray(req.body.warehouseStocks) ||
        req.body.warehouseStocks.length === 0
      ) {
        throw new Error("warehouseStocks is required for SIMPLE products");
      }
      if (req.body.price == null) {
        throw new Error("price is required for SIMPLE products");
      }

      if (Array.isArray(req.body.variants) && req.body.variants.length > 0) {
        throw new Error("variants must be empty for SIMPLE products");
      }

      if (Array.isArray(req.body.options) && req.body.options.length > 0) {
        throw new Error("options must be empty for SIMPLE products");
      }
    }

    if (value === productTypeEnum.VARIANT) {
      if (!Array.isArray(req.body.variants) || req.body.variants.length === 0) {
        throw new Error("variants are required for VARIANT products");
      }

      if (
        Array.isArray(req.body.warehouseStocks) &&
        req.body.warehouseStocks.length > 0
      ) {
        throw new Error(
          "warehouseStocks must be empty for VARIANT products; use variants[*].warehouseStocks instead"
        );
      }

      if (req.body.price != null || req.body.discountedPrice != null) {
        throw new Error(
          "price and discountedPrice must be omitted for VARIANT products; use variants[*].price instead"
        );
      }
    }

    return true;
  }),

  validatorMiddleware,
];

export const updateProductValidator = [
  param("id").isMongoId().withMessage("Invalid product id"),

  body("slug").not().exists().withMessage("slug cannot be updated"),

  body("type").not().exists().withMessage("type cannot be updated"),

  body("subcategory")
    .optional()
    .isMongoId()
    .withMessage("subcategory must be a valid id"),

  body("brand")
    .optional({ nullable: true })
    .isMongoId()
    .withMessage("brand must be a valid id"),

  body("name_en")
    .optional()
    .isString()
    .withMessage("English name must be a string"),

  body("name_ar")
    .optional()
    .isString()
    .withMessage("Arabic name must be a string"),

  body("desc_en")
    .optional()
    .isString()
    .withMessage("English description must be a string"),

  body("desc_ar")
    .optional()
    .isString()
    .withMessage("Arabic description must be a string"),

  body("price").optional().isNumeric().withMessage("price must be a number"),

  body("discountedPrice")
    .optional()
    .isNumeric()
    .withMessage("discountedPrice must be a number"),

  body("tags").optional().isArray().withMessage("tags must be an array"),

  body("tags.*").optional().isString().withMessage("each tag must be a string"),

  body("warehouseStocks")
    .optional()
    .isArray()
    .withMessage("warehouseStocks must be an array"),

  body("warehouseStocks.*.warehouse")
    .optional()
    .isMongoId()
    .withMessage("warehouseStocks.*.warehouse must be a valid id"),

  body("warehouseStocks.*.quantity")
    .optional()
    .isNumeric()
    .withMessage("warehouseStocks.*.quantity must be a number"),

  body("variants")
    .optional()
    .isArray()
    .withMessage("variants must be an array"),

  body("variants.*._id")
    .optional()
    .isMongoId()
    .withMessage("variant _id must be a valid id"),

  body("variants.*.price")
    .optional()
    .isNumeric()
    .withMessage("variant price must be a number"),

  body("variants.*.discountedPrice")
    .optional()
    .isNumeric()
    .withMessage("variant discountedPrice must be a number"),

  body("variants.*.warehouseStocks")
    .optional()
    .isArray()
    .withMessage("variant warehouseStocks must be an array"),

  body("variants.*.warehouseStocks.*.warehouse")
    .optional()
    .isMongoId()
    .withMessage("variant warehouseStocks.*.warehouse must be a valid id"),

  body("variants.*.warehouseStocks.*.quantity")
    .optional()
    .isNumeric()
    .withMessage("variant warehouseStocks.*.quantity must be a number"),

  validatorMiddleware,
];

export const productIdParamValidator = [
  param("id").isMongoId().withMessage("Invalid product id"),

  validatorMiddleware,
];

function mongoIdOrCsvValidator(fieldName) {
  return (value) => {
    const str = String(value).trim();
    if (!str) {
      throw new Error(message);
    }

    const ids = str.split(",").map((s) => s.trim());
    if (ids.length === 0 || ids.some((id) => !validator.isMongoId(id))) {
      throw new Error(`${fieldName} must be a mongo id or comma-separated ids`);
    }

    return true;
  };
}

export const listProductsQueryValidator = [
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("page must be a positive integer"),

  query("limit")
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage("limit must be an integer between 1 and 100"),

  query("sort").optional().isString().withMessage("sort must be a string"),

  query("sortKey")
    .optional()
    .isIn([
      "featured",
      "alpha_asc",
      "alpha_desc",
      "price_asc",
      "price_desc",
      "date_asc",
      "date_desc",
    ])
    .withMessage("Invalid sortKey"),

  query("q").optional().isString().withMessage("q must be a string"),

  query("category").optional().custom(mongoIdOrCsvValidator("category")),

  query("subcategory").optional().custom(mongoIdOrCsvValidator("subcategory")),

  query("brand").optional().custom(mongoIdOrCsvValidator("brand")),

  query("warehouse")
    .optional()
    .isMongoId()
    .withMessage("warehouse must be a valid id"),

  query("type")
    .optional()
    .customSanitizer((value) => normalizeProductType(value))
    .isIn(Object.values(productTypeEnum))
    .withMessage("type must be either SIMPLE or VARIANT"),

  query("isFeatured")
    .optional()
    .isBoolean()
    .withMessage("isFeatured must be a boolean"),

  query("isActive")
    .optional()
    .isBoolean()
    .withMessage("isActive must be a boolean"),

  query("collection")
    .optional()
    .isMongoId()
    .withMessage("collection must be a valid id"),

  validatorMiddleware,
];
