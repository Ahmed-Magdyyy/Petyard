import express from "express";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { previewUserCheckoutService } from "../../checkout/checkout.preview.js";
import { requireCartActions } from "../shared/assistant.config.js";
import { fields, objectId } from "../shared/assistant.validation.js";
import { AssistantError, reject } from "../shared/assistant.errors.js";
import { admitCartRequest } from "./assistant.cart-proposals.js";
import { checkoutSummaryValidator } from "./assistant.checkout.validators.js";

export async function getAssistantCheckoutSummary(owner, query, config) {
  requireCartActions(config);
  fields(query, ["warehouseId", "language"]);
  const warehouseId = String(objectId(query.warehouseId));
  if (!["ar", "en"].includes(query.language)) reject("invalid_request");
  await admitCartRequest(owner, config);
  try { return await previewUserCheckoutService({ userId: String(owner), warehouseId, lang: query.language }); }
  catch (error) {
    if (error instanceof AssistantError) throw error;
    if (error instanceof ApiError && [400, 404, 409].includes(error.statusCode)) reject("cart_requote_required", 409);
    throw error;
  }
}

// Parent router authenticates this owner; no guest identity or model-generated URL is accepted.
export function createAssistantCheckoutRouter({ getConfig } = {}) {
  const router = express.Router();
  router.get("/", (_req, _res, next) => {
    try { requireCartActions(getConfig()); next(); } catch (error) { next(error); }
  }, checkoutSummaryValidator, async (req, res, next) => {
    try { res.json({ data: await getAssistantCheckoutSummary(req.user._id, req.query, getConfig()) }); }
    catch (error) { next(error); }
  });
  return router;
}
