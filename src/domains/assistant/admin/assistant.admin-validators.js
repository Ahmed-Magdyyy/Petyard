import { body, checkExact, header, param, query } from "express-validator";
import { requireEnabled } from "../shared/assistant.config.js";
import { reject } from "../shared/assistant.errors.js";
import { fields, text } from "../shared/assistant.validation.js";
import { assistantValidatorMiddleware } from "../shared/assistant.validators.js";
import { usageReportPeriod } from "../reporting/assistant.reporting.js";

const identifier = (chain) => chain.isString().bail().isMongoId();
const limit = () => query("limit").optional().custom((value) => typeof value === "string" &&
  Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 100);
const beforeSequence = () => query("before").optional().custom((value) => typeof value === "string" &&
  Number.isSafeInteger(Number(value)) && Number(value) >= 1);

// Services retain analytics authority, owned lookup, auditing and non-HTTP validation.
export function adminAssistantValidators(getConfig) {
  const enabled = (_req, _res, next) => {
    try { requireEnabled(getConfig()); next(); } catch (error) { next(error); }
  };
  const reviewEnabled = (_req, _res, next) => {
    try { const config = requireEnabled(getConfig()); if (!config.reviewPolicy) reject("review_policy_required", 503); next(); }
    catch (error) { next(error); }
  };
  const exactBody = (allowed, chains, gate = enabled) => [...(gate ? [gate] : []),
    body().custom((value) => Boolean(fields(value, allowed))), ...chains, assistantValidatorMiddleware];
  const history = () => [enabled, checkExact([beforeSequence(), limit()], { locations: ["query"] }), assistantValidatorMiddleware];
  return {
    businessMessage: exactBody(["text"], [
      body("text").custom((value) => Boolean(text(value, getConfig().maxMessageChars))),
      header("Idempotency-Key").isString().bail().matches(/^[a-zA-Z0-9._:-]{8,128}$/),
    ]),
    businessHistory: history(),
    businessRun: [enabled, identifier(param("runId")), assistantValidatorMiddleware],
    usage: [enabled, checkExact([
      query("month").optional().custom((value) => { usageReportPeriod({ month: value }, getConfig().timezone); return true; }),
    ], { locations: ["query"] }), assistantValidatorMiddleware],
    candidates: [reviewEnabled, checkExact([identifier(query("after").optional()), limit()], { locations: ["query"] }), assistantValidatorMiddleware],
    dismiss: exactBody(["reviewSnapshotId", "reason"], [
      identifier(param("userId")), identifier(body("reviewSnapshotId")),
      body("reason").custom((value) => Boolean(text(value, 500))),
    ], reviewEnabled),
    reviewHistory: [enabled, identifier(param("userId")), ...history().slice(1)],
    observations: [enabled, identifier(param("userId")), checkExact([
      identifier(query("before").optional()), limit(),
    ], { locations: ["query"] }), assistantValidatorMiddleware],
    access: exactBody(["blocked", "reason"], [
      identifier(param("userId")), body("blocked").custom((value) => typeof value === "boolean"),
      body("reason").custom((value) => Boolean(text(value, 500))),
    ]),
    reconcile: exactBody(["resolution", "reason"], [
      identifier(param("runId")), body("resolution").custom((value) => value === "charge_reserved"),
      body("reason").custom((value) => Boolean(text(value, 500))),
    ]),
    embeddingList: [checkExact([identifier(query("before").optional()), limit()], { locations: ["query"] }), assistantValidatorMiddleware],
    embeddingBatch: [identifier(param("batchId")), checkExact([], { locations: ["query"] }), assistantValidatorMiddleware],
    embeddingReconcile: exactBody(["resolution", "reason"], [
      identifier(param("batchId")), body("resolution").custom(value => value === "charge_reserved"),
      body("reason").custom(value => Boolean(text(value, 500))), checkExact([], { locations: ["query"] }),
    ], null),
  };
}
