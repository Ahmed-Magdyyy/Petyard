import { body, checkExact, param, query } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";
import { toPiastres } from "../../shared/utils/money.js";
import { normalizeFixedBundleComponents } from "./bundle.components.js";
import { bundleRevision } from "./bundle.draft-input.js";

const exact = () => checkExact([], { locations: ["body", "query"] });
const revision = () => body("expectedRevision").custom(value => { bundleRevision(value); return true; });
const draftId = () => param("bundleId").isMongoId();
const definition = () => [
  body("name_en").isString().bail().trim().notEmpty().isLength({ max: 200 }),
  body("name_ar").optional().isString().bail().trim().isLength({ max: 200 }),
  body("desc_en").optional().isString().bail().trim().isLength({ max: 2000 }),
  body("desc_ar").optional().isString().bail().trim().isLength({ max: 2000 }),
  body("price").custom(value => { toPiastres(value, "bundlePrice"); return true; }),
  body("components").custom(value => { normalizeFixedBundleComponents(value); return true; }),
];
export const createBundleDraftValidator = [...definition(), exact(), validatorMiddleware];
export const replaceBundleDraftValidator = [draftId(), ...definition(), revision(), exact(), validatorMiddleware];
export const deleteBundleDraftValidator = [draftId(), revision(), exact(), validatorMiddleware];
export const getBundleDraftValidator = [draftId(), exact(), validatorMiddleware];
export const changeBundleAvailabilityValidator = [draftId(), revision(), exact(), validatorMiddleware];
export const listBundleDraftsValidator = [
  query("cursor").optional().isMongoId(),
  query("status").optional().isString().bail().isIn(["draft", "published", "paused", "rejected"]),
  query("limit").optional().custom(value => typeof value === "string" && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 50),
  exact(), validatorMiddleware,
];
