import express from "express";
import { requireCartActions } from "../shared/assistant.config.js";
import { reject } from "../shared/assistant.errors.js";
import { fields } from "../shared/assistant.validation.js";
import * as service from "./assistant.cart-api.js";
import { prepareCartProposalValidator, cartProposalIdValidator, confirmCartProposalValidator } from "./assistant.cart.validators.js";

// Mounted after the normal authenticated, phone-verified assistant boundary.
export function createAssistantCartRouter({ getConfig, application = service } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use((req, _res, next) => {
    try {
      const config = getConfig();
      requireCartActions(config);
      fields(req.query, []);
      if (req.method !== "GET" && Buffer.byteLength(JSON.stringify(req.body ?? {})) > 2048) reject("payload_too_large", 413);
      next();
    } catch (error) { next(error); }
  });
  const handle = (callback) => async (req, res, next) => {
    try { await callback(req, res, getConfig()); } catch (error) { next(error); }
  };
  router.post("/", prepareCartProposalValidator, handle(async (req, res, config) => {
    const result = await application.prepareCartProposal(req.user._id, req.body, req.get("Idempotency-Key"), config);
    res.status(result.duplicate ? 200 : 201).json({ data: result });
  }));
  router.get("/:proposalId", cartProposalIdValidator, handle(async (req, res, config) => {
    res.json({ data: await application.getCartProposal(req.user._id, req.params.proposalId, req.query, config) });
  }));
  router.post("/:proposalId/confirmations", confirmCartProposalValidator, handle(async (req, res, config) => {
    res.json({ data: await application.confirmCartProposal(req.user._id, req.params.proposalId, req.body, config) });
  }));
  return router;
}
