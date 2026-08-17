import asyncHandler from "express-async-handler";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  createSubstitutionOfferService,
  getSubstitutionRequestForOwnerService,
  getSubstitutionRequestForStaffService,
  listSubstitutionCandidatesService,
  listSubstitutionRequestsForOwnerService,
  listSubstitutionRequestsForStaffService,
  quoteSubstitutionService,
  retrySubstitutionCardPaymentService,
  respondToSubstitutionService,
} from "./substitution.service.js";
import {
  presentSubstitutionPayment,
  presentSubstitutionQuote,
  presentSubstitutionRefund,
  presentSubstitutionRequest,
} from "./substitution.presenter.js";

function getGuestId(req) {
  const value = req.headers["x-guest-id"];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireGuestId(req) {
  const guestId = getGuestId(req);
  if (!guestId) throw new ApiError("x-guest-id header is required", 400);
  return guestId;
}

function presentList(requests, options) {
  return (requests || []).map((request) =>
    presentSubstitutionRequest(request, options),
  );
}

export const listSubstitutionCandidates = asyncHandler(async (req, res) => {
  const result = await listSubstitutionCandidatesService({
    orderId: req.params.id,
    lineId: req.query.lineId,
    warehouseScope: req.orderWarehouseScope,
    lang: req.lang,
    q: req.query.q,
    page: req.query.page,
    limit: req.query.limit,
  });
  res.status(200).json(result);
});

export const createSubstitutionOffer = asyncHandler(async (req, res) => {
  console.log(
    "POST /api/v1/orders/admin/:id/substitutions req.body:",
    JSON.stringify(req.body, null, 2),
  );

  const result = await createSubstitutionOfferService({
    orderId: req.params.id,
    actorUserId: req.user._id,
    warehouseScope: req.orderWarehouseScope,
    idempotencyKey: req.get("idempotency-key"),
    expiresInMinutes: req.body.expiresInMinutes,
    shortages: req.body.shortages,
  });
  res.status(result.idempotent ? 200 : 201).json({
    data: presentSubstitutionRequest(result.request, {
      staff: true,
      lang: req.lang,
    }),
    idempotent: result.idempotent,
  });
});

export const listSubstitutionRequestsForStaff = asyncHandler(
  async (req, res) => {
    const requests = await listSubstitutionRequestsForStaffService({
      orderId: req.params.id,
      warehouseScope: req.orderWarehouseScope,
    });
    res.status(200).json({
      results: requests.length,
      data: presentList(requests, { staff: true, lang: req.lang }),
    });
  },
);

export const getSubstitutionRequestForStaff = asyncHandler(async (req, res) => {
  const request = await getSubstitutionRequestForStaffService({
    orderId: req.params.id,
    requestId: req.params.requestId,
    warehouseScope: req.orderWarehouseScope,
  });
  res.status(200).json({
    data: presentSubstitutionRequest(request, {
      staff: true,
      lang: req.lang,
    }),
  });
});

async function listForOwner(req, res, owner) {
  const requests = await listSubstitutionRequestsForOwnerService({
    orderId: req.params.id,
    ...owner,
  });
  res.status(200).json({
    results: requests.length,
    data: presentList(requests, { lang: req.lang }),
  });
}

async function getForOwner(req, res, owner) {
  const request = await getSubstitutionRequestForOwnerService({
    orderId: req.params.id,
    requestId: req.params.requestId,
    ...owner,
  });
  res.status(200).json({
    data: presentSubstitutionRequest(request, { lang: req.lang }),
  });
}

async function quoteForOwner(req, res, owner) {
  const quote = await quoteSubstitutionService({
    orderId: req.params.id,
    requestId: req.params.requestId,
    requestRevision: req.body.requestRevision,
    selections: req.body.selections,
    ...owner,
  });
  res.status(200).json({ data: presentSubstitutionQuote(quote) });
}

async function respondForOwner(req, res, owner) {
  const result = await respondToSubstitutionService({
    orderId: req.params.id,
    requestId: req.params.requestId,
    idempotencyKey: req.get("idempotency-key"),
    requestRevision: req.body.requestRevision,
    selections: req.body.selections,
    quoteRevision: req.body.quoteRevision,
    quotedWalletBalancePiastres: req.body.quotedWalletBalancePiastres,
    savedCardId: req.body.savedCardId,
    additionalInstapayScreenshotFiles: req.files,
    ...owner,
  });
  res.status(200).json({
    data: presentSubstitutionRequest(result.request, { lang: req.lang }),
    action: result.action,
    idempotent: result.idempotent,
    payment: presentSubstitutionPayment(result.payment),
    refund: presentSubstitutionRefund(result.refund),
  });
}

async function retryPaymentForOwner(req, res, owner) {
  const result = await retrySubstitutionCardPaymentService({
    orderId: req.params.id,
    requestId: req.params.requestId,
    attemptId: req.params.attemptId,
    idempotencyKey: req.get("idempotency-key"),
    savedCardId: req.body.savedCardId,
    ...owner,
  });
  res.status(200).json({
    data: presentSubstitutionPayment(result.payment),
  });
}

export const listMySubstitutionRequests = asyncHandler((req, res) =>
  listForOwner(req, res, { userId: req.user._id }),
);
export const getMySubstitutionRequest = asyncHandler((req, res) =>
  getForOwner(req, res, { userId: req.user._id }),
);
export const quoteMySubstitution = asyncHandler((req, res) =>
  quoteForOwner(req, res, { userId: req.user._id }),
);
export const respondToMySubstitution = asyncHandler((req, res) => {
  console.log(
    "POST /api/v1/orders/me/:id/substitutions/:requestId/respond req.body:",
    JSON.stringify(req.body, null, 2),
  );

  return respondForOwner(req, res, { userId: req.user._id });
});
export const retryMySubstitutionPayment = asyncHandler((req, res) =>
  retryPaymentForOwner(req, res, { userId: req.user._id }),
);
export const listGuestSubstitutionRequests = asyncHandler((req, res) =>
  listForOwner(req, res, { guestId: requireGuestId(req) }),
);
export const getGuestSubstitutionRequest = asyncHandler((req, res) =>
  getForOwner(req, res, { guestId: requireGuestId(req) }),
);
export const quoteGuestSubstitution = asyncHandler((req, res) =>
  quoteForOwner(req, res, { guestId: requireGuestId(req) }),
);
export const respondToGuestSubstitution = asyncHandler((req, res) =>
  respondForOwner(req, res, { guestId: requireGuestId(req) }),
);
export const retryGuestSubstitutionPayment = asyncHandler((req, res) =>
  retryPaymentForOwner(req, res, { guestId: requireGuestId(req) }),
);
