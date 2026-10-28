import express from "express";
import { protect, allowedTo } from "../auth/auth.middleware.js";
import { roles } from "../../shared/constants/enums.js";
import { loadAssistantConfig } from "./shared/assistant.config.js";
import { assistantErrorHandler } from "./shared/assistant.errors.js";
import * as service from "./customer/assistant.service.js";
import { createBusinessAssistantRouter } from "./admin/assistant.admin-routes.js";
import { createAssistantCartRouter } from "./customer/assistant.cart-routes.js";
import { createAssistantCheckoutRouter } from "./customer/assistant.checkout.js";
import { createAssistantBookingRouter } from "./customer/assistant.booking-reads.js";
import { createAssistantBookingProposalRouter } from "./customer/assistant.booking-routes.js";
import { customerAssistantValidators } from "./customer/assistant.validators.js";
import { adminAssistantValidators } from "./admin/assistant.admin-validators.js";
import { createReferenceRouter } from "./references/assistant.reference-routes.js";
import { loadReferenceConfig } from "./references/assistant.reference-config.js";
import { embeddingReviewService } from "./admin/assistant.embedding-review.js";
import { cairoTimestampReplacer } from "../../shared/utils/egyptTimezone.js";

// Dependency injection is only for local HTTP tests; production always supplies the real auth and domain service.
export function createAssistantRouter({ authenticate = protect, superAdmin = allowedTo(roles.SUPER_ADMIN),
  getConfig = loadAssistantConfig, application = service, businessApplication, cartApplication, bookingApplication, bookingProposalApplication,
  referenceApplication, getReferenceConfig = loadReferenceConfig, embeddingReviewApplication = embeddingReviewService } = {}) {
  const router = express.Router();
  const validators = customerAssistantValidators(getConfig);
  const adminValidators = adminAssistantValidators(getConfig);
  router.use("/admin/business", createBusinessAssistantRouter({ authenticate, getConfig, application: businessApplication }));
  router.use("/admin/references", createReferenceRouter({ authenticate, superAdmin, getConfig: getReferenceConfig, application: referenceApplication }));
  router.use("/admin", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use("/dietary-warnings", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use("/cart-proposals", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use("/checkout-summary", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use("/booking", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use("/booking-proposals", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use(authenticate);
  router.use("/cart-proposals", createAssistantCartRouter({ getConfig, application: cartApplication }));
  router.use("/checkout-summary", createAssistantCheckoutRouter({ getConfig }));
  router.use("/booking", createAssistantBookingRouter({ getConfig, application: bookingApplication }));
  router.use("/booking-proposals", createAssistantBookingProposalRouter({ getConfig, application: bookingProposalApplication }));
  const handle = (callback) => async (req, res, next) => {
    try { await callback(req, res, getConfig()); } catch (error) { next(error); }
  };
  // Reviewing saved financial evidence must remain available with chat and provider configuration disabled.
  const embeddingReview = callback => async (req, res, next) => {
    try { res.type("application/json").send(JSON.stringify({ data: await callback(req) }, cairoTimestampReplacer)); } catch (error) { next(error); }
  };
  router.get("/admin/embedding-batches", superAdmin, adminValidators.embeddingList,
    embeddingReview(req => embeddingReviewApplication.list(req.user._id, req.query)));
  router.get("/admin/embedding-batches/:batchId", superAdmin, adminValidators.embeddingBatch,
    embeddingReview(req => embeddingReviewApplication.get(req.user._id, req.params.batchId)));
  router.post("/admin/embedding-batches/:batchId/reconcile", superAdmin, adminValidators.embeddingReconcile,
    embeddingReview(req => embeddingReviewApplication.reconcile(req.user._id, req.params.batchId, req.body)));
  router.get("/metadata", handle(async (req, res, config) => res.json({ data: await application.getMetadata(req.user._id, config) })));
  router.get("/chat", handle(async (req, res, config) => res.json({ data: await application.getChat(req.user._id, config) })));
  router.get("/messages", validators.history, handle(async (req, res, config) => res.json({ data: await application.getHistory(req.user._id, req.query, config) })));
  router.post("/messages", validators.message, handle(async (req, res, config) => {
    const result = await application.submitMessage(req.user._id, req.body, req.get("Idempotency-Key"), config);
    res.status(result.duplicate ? 200 : 202).json({ data: result });
  }));
  router.get("/runs/:runId", validators.run, handle(async (req, res, config) => res.json({ data: await application.getRun(req.user._id, req.params.runId, config) })));
  router.put("/subject", validators.subject, handle(async (req, res, config) => res.json({ data: await application.changeSubject(req.user._id, req.body, config) })));
  router.post("/subjects", validators.createSubject, handle(async (req, res, config) => res.status(201).json({ data: await application.changeSubject(req.user._id, req.body, config, true) })));
  router.get("/memory", handle(async (req, res, config) => res.json({ data: await application.listMemory(req.user._id, config) })));
  router.put("/memory", validators.memory, handle(async (req, res, config) => res.json({ data: await application.saveMemory(req.user._id, req.body, config) })));
  router.delete("/memory/:memoryId", validators.forgetMemory, handle(async (req, res, config) => res.json({ data: await application.forgetMemory(req.user._id, req.params.memoryId, config) })));
  router.get("/dietary-warnings", validators.warnings, handle(async (req, res, config) => res.json({ data: await application.listDietaryWarnings(req.user._id, req.query, config) })));
  router.put("/dietary-warnings/:warningId", validators.editWarning, handle(async (req, res, config) => res.json({ data: await application.editDietaryWarning(req.user._id, req.params.warningId, req.body, config) })));
  router.post("/dietary-warnings/:warningId/removals", validators.removeWarning, handle(async (req, res, config) => res.json({ data: await application.removeDietaryWarning(req.user._id, req.params.warningId, req.body, config) })));
  router.get("/admin/usage", superAdmin, adminValidators.usage, handle(async (req, res, config) => res.set("Cache-Control", "no-store")
    .json({ data: await application.getUsageReport(req.query, config) })));
  router.get("/admin/outcomes", superAdmin, adminValidators.usage, handle(async (req, res, config) => res.json({ data: await application.getOutcomeReport(req.user._id, req.query, config) })));
  router.get("/admin/review-candidates", superAdmin, adminValidators.candidates, handle(async (req, res, config) => res.set("Cache-Control", "no-store")
    .json({ data: await application.getReviewCandidates(req.user._id, req.query, config) })));
  router.post("/admin/accounts/:userId/review-dismissals", superAdmin, adminValidators.dismiss, handle(async (req, res, config) => res.set("Cache-Control", "no-store")
    .json({ data: await application.dismissReviewCandidate(req.user._id, req.params.userId, req.body, config) })));
  router.get("/admin/accounts/:userId/messages", superAdmin, adminValidators.reviewHistory, handle(async (req, res, config) => res.set("Cache-Control", "no-store")
    .json({ data: await application.reviewHistory(req.user._id, req.params.userId, req.query, config) })));
  router.get("/admin/accounts/:userId/observations", superAdmin, adminValidators.observations, handle(async (req, res, config) => res.set("Cache-Control", "no-store")
    .json({ data: await application.reviewObservations(req.user._id, req.params.userId, req.query, config) })));
  router.put("/admin/accounts/:userId/access", superAdmin, adminValidators.access, handle(async (req, res, config) => res.json({ data: await application.restrictAccount(req.user._id, req.params.userId, req.body, config) })));
  router.post("/admin/runs/:runId/reconcile", superAdmin, adminValidators.reconcile, handle(async (req, res, config) => res.json({ data: await application.reconcileRun(req.user._id, req.params.runId, req.body, config) })));
  router.use(assistantErrorHandler);
  return router;
}

export default createAssistantRouter();
