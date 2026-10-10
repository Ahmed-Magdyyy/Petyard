import express from "express";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { MAX_BUNNY_WEBHOOK_BYTES } from "./bunnyStreamWebhook.validators.js";

export const BUNNY_STREAM_WEBHOOK_PATH = "/api/v1/integrations/bunny-stream/webhook";
const readRawBody = express.raw({ type: "application/json", limit: MAX_BUNNY_WEBHOOK_BYTES,
  inflate: false, verify(req, _res, body) { req.bunnyStreamRawBody = Buffer.from(body); } });

// Mount only on the webhook path, before general JSON/form parsers. Capture
// bytes here, but retain the normal downstream security/error middleware chain.
export function bunnyStreamWebhookBody(req, res, next) {
  if (req.method !== "POST") return next();
  if (!req.is("application/json")) {
    return next(new ApiError("Bunny webhook requires application/json", 415,
      [{ code: "VIDEO_WEBHOOK_INVALID_BODY" }]));
  }
  readRawBody(req, res, error => {
    if (!error) return next();
    const status = [400, 413, 415].includes(error.status) ? error.status : 400;
    next(new ApiError("Invalid Bunny webhook body", status, [{ code: "VIDEO_WEBHOOK_INVALID_BODY" }]));
  });
}
