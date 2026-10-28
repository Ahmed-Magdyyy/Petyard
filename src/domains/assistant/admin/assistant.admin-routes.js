import express from "express";
import { protect } from "../../auth/auth.middleware.js";
import { loadAssistantConfig } from "../shared/assistant.config.js";
import { assistantErrorHandler } from "../shared/assistant.errors.js";
import * as service from "./assistant.admin-service.js";
import { adminAssistantValidators } from "./assistant.admin-validators.js";
import { cairoTimestampReplacer } from "../../../shared/utils/egyptTimezone.js";

// Current analytics authority is enforced by the service; no role/account is accepted from the client.
export function createBusinessAssistantRouter({ authenticate = protect, getConfig = loadAssistantConfig, application = service } = {}) {
  const router = express.Router();
  const validators = adminAssistantValidators(getConfig);
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use(authenticate);
  const handle = (callback) => async (req, res, next) => {
    try { await callback(req, res, getConfig()); } catch (error) { next(error); }
  };
  // Match Cairo timestamps while preserving literal report labels and user text.
  const send = (res, data, status = 200) => res.status(status).type("application/json").send(JSON.stringify({ data }, cairoTimestampReplacer));
  router.get("/metadata", handle(async (req, res, config) => send(res, await application.getBusinessMetadata(req.user._id, config))));
  router.get("/chat", handle(async (req, res, config) => send(res, await application.getBusinessChat(req.user._id, config))));
  router.get("/messages", validators.businessHistory, handle(async (req, res, config) => send(res, await application.getBusinessHistory(req.user._id, req.query, config))));
  router.post("/messages", validators.businessMessage, handle(async (req, res, config) => {
    const result = await application.submitBusinessMessage(req.user._id, req.body, req.get("Idempotency-Key"), config);
    send(res, result, result.duplicate ? 200 : 202);
  }));
  router.get("/runs/:runId", validators.businessRun, handle(async (req, res, config) => send(res, await application.getBusinessRun(req.user._id, req.params.runId, config))));
  router.use((error, req, res, next) => assistantErrorHandler(error, req, res, next, { business: true }));
  return router;
}
