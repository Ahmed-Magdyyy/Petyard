import express from "express";
import { AssistantError, assistantErrorHandler } from "./shared/assistant.errors.js";
import { referenceErrorHandler } from "./references/assistant.reference-routes.js";

// Keep the existing customer parser behavior; business errors use the private dashboard envelope.
export const assistantBody = [express.json({ limit: "24kb" }), (error, req, res, next) => {
  if (/^\/admin\/references(?:\/|$)/i.test(req.path)) return referenceErrorHandler(
    error.type === "entity.parse.failed" ? new AssistantError("invalid_request", 400)
      : (error.status === 413 ? new AssistantError("reference_file_too_large", 413) : error), req, res, next);
  const business = /^\/admin\/business(?:\/|$)/i.test(req.path);
  if (business) res.set("Cache-Control", "no-store");
  assistantErrorHandler(business && error.type === "entity.parse.failed" ? new AssistantError("invalid_request", 400) : error,
    req, res, next, { business });
}];

export function assistantAwareApiLimit(req, res, next, options) {
  if (/^\/api\/v1\/assistant\/admin\/references(?:\/|\?|$)/i.test(req.originalUrl)) {
    return referenceErrorHandler(new AssistantError("request_rate_limit", 429), req, res, next);
  }
  if (/^\/api\/v1\/assistant\/admin\/business(?:\/|\?|$)/i.test(req.originalUrl)) {
    res.set("Cache-Control", "no-store");
    return assistantErrorHandler(new AssistantError("request_rate_limit", 429, req.rateLimit?.resetTime ?? null), req, res, next, { business: true });
  }
  return res.status(options.statusCode).send(options.message);
}
