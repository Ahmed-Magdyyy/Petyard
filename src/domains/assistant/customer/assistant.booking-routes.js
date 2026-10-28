import express from "express";
import { requireBookingActions, requireBookingReads } from "../shared/assistant.config.js";
import { reject } from "../shared/assistant.errors.js";
import * as service from "./assistant.booking-api.js";
import { prepareBookingReviewValidator, bookingReviewIdValidator, confirmBookingReviewValidator } from "./assistant.booking.validators.js";

export function createAssistantBookingProposalRouter({ getConfig, application = service } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    try {
      (req.method === "GET" ? requireBookingReads : requireBookingActions)(getConfig());
      if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > 32768) reject("payload_too_large", 413);
      next();
    } catch (error) { next(error); }
  });
  const handle = method => async (req, res, next) => {
    try {
      const config = getConfig(), owner = req.user._id, id = req.params.proposalId;
      const result = method === "prepareBookingReview" ? await application[method](owner, req.body, req.get("Idempotency-Key"), config)
        : method === "confirmBookingReview" ? await application[method](owner, id, req.body, config) : await application[method](owner, id, config);
      res.status(method === "prepareBookingReview" && !result.duplicate ? 201 : 200).json({ data: result });
    } catch (error) { next(error); }
  };
  router.post("/", prepareBookingReviewValidator, handle("prepareBookingReview"));
  router.get("/:proposalId", bookingReviewIdValidator, handle("getBookingReview"));
  router.post("/:proposalId/confirmations", confirmBookingReviewValidator, handle("confirmBookingReview"));
  router.get("/:proposalId/status", bookingReviewIdValidator, handle("getBookingReviewStatus"));
  return router;
}
