import asyncHandler from "express-async-handler";
import {
  createReturnRequestService,
  listReturnRequestsService,
  getReturnRequestByIdService,
  processReturnRequestService,
} from "./return.service.js";
import { ApiError } from "../../shared/utils/ApiError.js";

// ─── Helper: resolve actor from request ─────────────────────────────────────
// Authenticated user → userId.  No auth + guestId query → guestId.  Neither → 401.

function resolveActor(req) {
  if (req.user?._id) {
    return { userId: req.user._id, guestId: null };
  }

  const guestId = req.headers["x-guest-id"];
  if (guestId) {
    return { userId: null, guestId };
  }

  throw new ApiError("Please login or provide x-guest-id header", 401);
}

// ─── Create Return Request  (User or Guest — same route) ────────────────────

export const createReturnRequest = asyncHandler(async (req, res, next) => {
  const { userId, guestId } = resolveActor(req);
  const { orderId } = req.params;
  const { reason } = req.body;
  const lang = req.lang;

  const returnRequest = await createReturnRequestService({
    userId,
    guestId,
    orderId,
    reason,
    lang,
  });

  const result = returnRequest.toObject();
  // Only return the relevant identity field
  if (userId) delete result.guestId;
  if (guestId) delete result.user;

  res.status(201).json({ data: result });
});

// ─── List My Return Requests (User or Guest — same route) ───────────────────

export const getMyReturnRequests = asyncHandler(async (req, res, next) => {
  const { userId, guestId } = resolveActor(req);
  const { status, page, limit } = req.query;

  const result = await listReturnRequestsService({
    userId,
    guestId,
    status,
    page: page ? parseInt(page, 10) : 1,
    limit: limit ? parseInt(limit, 10) : 20,
  });

  res.status(200).json(result);
});

// ─── Get Single Return Request (User or Guest — same route) ─────────────────

export const getMyReturnRequest = asyncHandler(async (req, res, next) => {
  const { userId, guestId } = resolveActor(req);
  const { returnId } = req.params;

  const returnRequest = await getReturnRequestByIdService({
    returnId,
    userId,
    guestId,
  });

  res.status(200).json({ data: returnRequest });
});

// ─── Admin Controllers ──────────────────────────────────────────────────────

export const listReturnRequestsForAdmin = asyncHandler(async (req, res, next) => {
  const { status, page, limit, orderNumber } = req.query;

  const result = await listReturnRequestsService({
    status,
    orderNumber,
    page: page ? parseInt(page, 10) : 1,
    limit: limit ? parseInt(limit, 10) : 20,
  });

  res.status(200).json(result);
});

export const getReturnRequestForAdmin = asyncHandler(async (req, res, next) => {
  const { returnId } = req.params;

  const returnRequest = await getReturnRequestByIdService({
    returnId,
  });

  res.status(200).json({ data: returnRequest });
});

export const processReturnRequest = asyncHandler(async (req, res, next) => {
  const adminUserId = req.user?._id;
  const { returnId } = req.params;
  const { status, rejectionReason } = req.body;

  const returnRequest = await processReturnRequestService({
    returnId,
    action: status,
    adminUserId,
    rejectionReason,
  });

  res.status(200).json({ data: returnRequest });
});
