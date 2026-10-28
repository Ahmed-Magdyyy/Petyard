import { checkExact, param, query } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

const common = () => [query("warehouseId").isString().bail().isMongoId(), query("language").isString().bail().isIn(["en", "ar"])];
const exact = () => checkExact([], { locations: ["body", "query"] });
export const listBundleCatalogValidator = [...common(), query("cursor").optional().isString().bail().isMongoId(),
  query("limit").optional().custom(value => typeof value === "string" && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 50),
  exact(), validatorMiddleware];
export const getBundleCatalogValidator = [param("bundleId").isMongoId(), ...common(), exact(), validatorMiddleware];
