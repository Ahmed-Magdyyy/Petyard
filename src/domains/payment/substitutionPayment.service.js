import crypto from "node:crypto";
import {
  orderPaymentAttemptStatusEnum,
  refundOperationStatusEnum,
} from "../../shared/constants/enums.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { createPaymentIntention, getPublicKey } from "./paymob.service.js";
import { getSavedCardTokenService } from "./savedCard.service.js";
import { OrderPaymentAttemptModel } from "./orderPaymentAttempt.model.js";
import { RefundOperationModel } from "./refundOperation.model.js";

const ACTIVE_ATTEMPT_STATUSES = [
  orderPaymentAttemptStatusEnum.INITIALIZING,
  orderPaymentAttemptStatusEnum.AWAITING_PAYMENT,
];

const TERMINAL_ATTEMPT_STATUSES = new Set([
  orderPaymentAttemptStatusEnum.SUCCEEDED,
  orderPaymentAttemptStatusEnum.FAILED,
  orderPaymentAttemptStatusEnum.SUPERSEDED,
  orderPaymentAttemptStatusEnum.EXPIRED,
  orderPaymentAttemptStatusEnum.LATE_SUCCESS_REFUND_REQUIRED,
  orderPaymentAttemptStatusEnum.REFUNDED,
]);

const DEFAULT_CURRENCY = "EGP";

function resolveDependencies(overrides = {}) {
  return {
    paymentAttemptModel: OrderPaymentAttemptModel,
    refundOperationModel: RefundOperationModel,
    createPaymentIntention,
    getPublicKey,
    getSavedCardTokenService,
    now: () => new Date(),
    randomUUID: crypto.randomUUID,
    ...overrides,
  };
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCurrency(value) {
  const currency = normalizeString(value || DEFAULT_CURRENCY).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ApiError("A valid three-letter currency is required", 400);
  }
  return currency;
}

function normalizePositivePiastres(value) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new ApiError("amountPiastres must be a positive integer", 400);
  }
  return amount;
}

function normalizeFutureDate(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(`${fieldName} must be a valid date`, 400);
  }
  return date;
}

function validateExclusiveOwner({ userId, guestId }) {
  const hasUser = Boolean(userId);
  const hasGuest = Boolean(normalizeString(guestId));
  if (hasUser === hasGuest) {
    throw new ApiError("Exactly one of userId or guestId is required", 400);
  }
}

function idsEqual(left, right) {
  return String(left ?? "") === String(right ?? "");
}

function getId(document) {
  return document?._id ?? document?.id ?? null;
}

function sanitizeErrorCode(error) {
  const candidate =
    normalizeString(error?.code) ||
    normalizeString(error?.name) ||
    (Number.isInteger(error?.statusCode) ? `HTTP_${error.statusCode}` : "PAYMENT_INITIALIZATION_FAILED");
  return candidate
    .toUpperCase()
    .replace(/[^A-Z0-9_:-]/g, "_")
    .slice(0, 80);
}

function isDuplicateKeyError(error) {
  return error?.code === 11000 || error?.name === "MongoServerError" && error?.code === 11000;
}

function makeMerchantOrderId({ substitutionRequestId, requestIdempotencyKey }) {
  const requestPart = String(substitutionRequestId).replace(/[^a-zA-Z0-9]/g, "").slice(-24);
  const digest = crypto
    .createHash("sha256")
    .update(`${String(substitutionRequestId)}:${requestIdempotencyKey}`)
    .digest("hex")
    .slice(0, 20);
  return `SUB-${requestPart}-${digest}`;
}

function makeRefundOperationId({
  substitutionRequestId,
  paymentAttemptId,
  method,
  originalTransactionId,
  amountPiastres,
}) {
  const source = [
    substitutionRequestId,
    paymentAttemptId || "none",
    method,
    originalTransactionId || "none",
    amountPiastres,
  ].join(":");
  return `SUBREF-${crypto.createHash("sha256").update(source).digest("hex").slice(0, 32)}`;
}

function assertSameAttemptIntent(existing, desired) {
  const same =
    idsEqual(existing.order, desired.order) &&
    idsEqual(existing.substitutionRequest, desired.substitutionRequest) &&
    idsEqual(existing.user, desired.user) &&
    normalizeString(existing.guestId) === normalizeString(desired.guestId) &&
    Number(existing.amountPiastres) === Number(desired.amountPiastres) &&
    normalizeCurrency(existing.currency) === normalizeCurrency(desired.currency) &&
    idsEqual(existing.expiresAt?.getTime?.() ?? existing.expiresAt, desired.expiresAt?.getTime?.() ?? desired.expiresAt);

  if (!same) {
    throw new ApiError("Payment idempotency key conflicts with a different attempt", 409);
  }
}

function assertSameRefundIntent(existing, desired) {
  const same =
    idsEqual(existing.order, desired.order) &&
    idsEqual(existing.substitutionRequest, desired.substitutionRequest) &&
    idsEqual(existing.paymentAttempt, desired.paymentAttempt) &&
    idsEqual(existing.user, desired.user) &&
    normalizeString(existing.guestId) === normalizeString(desired.guestId) &&
    existing.method === desired.method &&
    Number(existing.amountPiastres) === Number(desired.amountPiastres) &&
    normalizeCurrency(existing.currency) === normalizeCurrency(desired.currency) &&
    normalizeString(existing.originalTransactionId) === normalizeString(desired.originalTransactionId);
  if (!same) {
    throw new ApiError("Refund operation id conflicts with a different refund", 409);
  }
}

function getAttemptId(attempt) {
  return attempt?._id ?? attempt?.id;
}

function applySession(query, session) {
  if (session && typeof query?.session === "function") return query.session(session);
  return query;
}

export async function createOrFindSubstitutionPaymentAttempt({
  orderId,
  substitutionRequestId,
  userId = null,
  guestId = null,
  requestIdempotencyKey,
  amountPiastres,
  currency = DEFAULT_CURRENCY,
  paymentExpiresAt,
  attemptNumber = 1,
  session = null,
  dependencies,
}) {
  validateExclusiveOwner({ userId, guestId });
  const normalizedKey = normalizeString(requestIdempotencyKey);
  if (!normalizedKey) {
    throw new ApiError("requestIdempotencyKey is required", 400);
  }
  if (!orderId || !substitutionRequestId) {
    throw new ApiError("orderId and substitutionRequestId are required", 400);
  }
  if (!Number.isSafeInteger(Number(attemptNumber)) || Number(attemptNumber) < 1) {
    throw new ApiError("attemptNumber must be a positive integer", 400);
  }

  const expiresAt = normalizeFutureDate(paymentExpiresAt, "paymentExpiresAt");
  const desired = {
    order: orderId,
    substitutionRequest: substitutionRequestId,
    user: userId || undefined,
    guestId: normalizeString(guestId) || undefined,
    requestIdempotencyKey: normalizedKey,
    merchantOrderId: makeMerchantOrderId({
      substitutionRequestId,
      requestIdempotencyKey: normalizedKey,
    }),
    amountPiastres: normalizePositivePiastres(amountPiastres),
    currency: normalizeCurrency(currency),
    expiresAt,
    attemptNumber: Number(attemptNumber),
    status: orderPaymentAttemptStatusEnum.INITIALIZING,
  };
  const { paymentAttemptModel } = resolveDependencies(dependencies);

  const existing = await applySession(
    paymentAttemptModel.findOne({
      substitutionRequest: substitutionRequestId,
      requestIdempotencyKey: normalizedKey,
    }),
    session,
  );
  if (existing) {
    assertSameAttemptIntent(existing, desired);
    return { attempt: existing, created: false };
  }

  try {
    const created = session
      ? await paymentAttemptModel.create([desired], { session })
      : await paymentAttemptModel.create(desired);
    const attempt = Array.isArray(created) ? created[0] : created;
    return { attempt, created: true };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const duplicate = await applySession(
      paymentAttemptModel.findOne({
        substitutionRequest: substitutionRequestId,
        requestIdempotencyKey: normalizedKey,
      }),
      session,
    );
    if (!duplicate) throw error;
    assertSameAttemptIntent(duplicate, desired);
    return { attempt: duplicate, created: false };
  }
}

export async function initializeSubstitutionPaymentAttempt({
  attemptId,
  billingData,
  savedCardId = null,
  orderNumber,
  dependencies,
}) {
  const deps = resolveDependencies(dependencies);
  const { paymentAttemptModel } = deps;
  const now = deps.now();
  const leaseToken = deps.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 30_000);

  const attempt = await paymentAttemptModel.findById(attemptId);
  if (!attempt) throw new ApiError("Payment attempt not found", 404);
  if (attempt.status === orderPaymentAttemptStatusEnum.AWAITING_PAYMENT) {
    return { attempt, clientSecret: null, publicKey: deps.getPublicKey(), alreadyInitialized: true };
  }
  if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
    throw new ApiError("Payment attempt is no longer payable", 409);
  }
  if (new Date(attempt.expiresAt).getTime() <= now.getTime()) {
    const expired = await markSubstitutionPaymentAttemptExpired({
      attemptId: getAttemptId(attempt),
      dependencies: deps,
    });
    return { attempt: expired ?? attempt, clientSecret: null, expired: true };
  }

  const claimed = await paymentAttemptModel.findOneAndUpdate(
    {
      _id: getAttemptId(attempt),
      status: orderPaymentAttemptStatusEnum.INITIALIZING,
      $or: [
        { initializationLeaseToken: { $exists: false } },
        { initializationLeaseToken: null },
        { initializationLeaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: { initializationLeaseToken: leaseToken, initializationLeaseExpiresAt: leaseExpiresAt },
    },
    { new: true },
  );

  if (!claimed) {
    const fresh = await paymentAttemptModel.findById(attemptId);
    return {
      attempt: fresh ?? attempt,
      clientSecret: null,
      publicKey: deps.getPublicKey(),
      initializationInProgress: true,
    };
  }

  try {
    let cardTokens = [];
    if (savedCardId) {
      if (!claimed.user) {
        throw new ApiError("Saved cards are only available to registered users", 400);
      }
      const token = await deps.getSavedCardTokenService(claimed.user, savedCardId);
      cardTokens = token ? [token] : [];
    }

    const intention = await deps.createPaymentIntention({
      merchantOrderId: claimed.merchantOrderId,
      amountCents: Number(claimed.amountPiastres),
      currency: normalizeCurrency(claimed.currency),
      billingData: billingData || {},
      items: [
        {
          name: `Substitution adjustment ${normalizeString(orderNumber) || ""}`.trim(),
          amountCents: Number(claimed.amountPiastres),
          quantity: 1,
        },
      ],
      cardTokens,
    });

    const initialized = await paymentAttemptModel.findOneAndUpdate(
      {
        _id: getAttemptId(claimed),
        status: orderPaymentAttemptStatusEnum.INITIALIZING,
        initializationLeaseToken: leaseToken,
      },
      {
        $set: {
          status: orderPaymentAttemptStatusEnum.AWAITING_PAYMENT,
          paymobIntentionId: intention.intentionId ? String(intention.intentionId) : undefined,
          paymobOrderId: intention.paymobOrderId ? String(intention.paymobOrderId) : undefined,
          initializedAt: deps.now(),
        },
        $unset: { initializationLeaseToken: 1, initializationLeaseExpiresAt: 1 },
      },
      { new: true },
    );

    if (!initialized) {
      throw new ApiError("Payment attempt initialization lease was lost", 409);
    }

    return {
      attempt: initialized,
      clientSecret: intention.clientSecret || null,
      publicKey: deps.getPublicKey(),
      alreadyInitialized: false,
    };
  } catch (error) {
    await markSubstitutionPaymentAttemptFailure({
      attemptId: getAttemptId(claimed),
      errorCode: sanitizeErrorCode(error),
      initializationLeaseToken: leaseToken,
      dependencies: deps,
    });
    throw error;
  }
}

export async function findSubstitutionPaymentAttemptByProviderRefs({
  merchantOrderId = null,
  paymobOrderId = null,
  paymobIntentionId = null,
  dependencies,
}) {
  const { paymentAttemptModel } = resolveDependencies(dependencies);
  const clauses = [];
  if (normalizeString(merchantOrderId)) clauses.push({ merchantOrderId: normalizeString(merchantOrderId) });
  if (normalizeString(paymobOrderId)) clauses.push({ paymobOrderId: normalizeString(paymobOrderId) });
  if (normalizeString(paymobIntentionId)) clauses.push({ paymobIntentionId: normalizeString(paymobIntentionId) });
  if (!clauses.length) return null;
  return paymentAttemptModel.findOne({ $or: clauses });
}

export async function markSubstitutionPaymentAttemptFailure({
  attemptId,
  errorCode = "PAYMENT_FAILED",
  initializationLeaseToken = null,
  dependencies,
}) {
  const deps = resolveDependencies(dependencies);
  const filter = {
    _id: attemptId,
    status: { $in: ACTIVE_ATTEMPT_STATUSES },
  };
  if (initializationLeaseToken) filter.initializationLeaseToken = initializationLeaseToken;
  return deps.paymentAttemptModel.findOneAndUpdate(
    filter,
    {
      $set: {
        status: orderPaymentAttemptStatusEnum.FAILED,
        failedAt: deps.now(),
        errorCode: sanitizeErrorCode({ code: errorCode }),
        errorAt: deps.now(),
      },
      $unset: { initializationLeaseToken: 1, initializationLeaseExpiresAt: 1 },
    },
    { new: true },
  );
}

export async function markSubstitutionPaymentAttemptSuperseded({
  attemptId,
  session = null,
  dependencies,
}) {
  const deps = resolveDependencies(dependencies);
  return deps.paymentAttemptModel.findOneAndUpdate(
    { _id: attemptId, status: { $in: ACTIVE_ATTEMPT_STATUSES } },
    {
      $set: {
        status: orderPaymentAttemptStatusEnum.SUPERSEDED,
        supersededAt: deps.now(),
      },
      $unset: { initializationLeaseToken: 1, initializationLeaseExpiresAt: 1 },
    },
    session ? { new: true, session } : { new: true },
  );
}

export async function markSubstitutionPaymentAttemptExpired({ attemptId, dependencies }) {
  const deps = resolveDependencies(dependencies);
  return deps.paymentAttemptModel.findOneAndUpdate(
    { _id: attemptId, status: { $in: ACTIVE_ATTEMPT_STATUSES } },
    {
      $set: { status: orderPaymentAttemptStatusEnum.EXPIRED, expiredAt: deps.now() },
      $unset: { initializationLeaseToken: 1, initializationLeaseExpiresAt: 1 },
    },
    { new: true },
  );
}

export async function claimAttemptSuccessAtomically({
  attemptId = null,
  merchantOrderId = null,
  paymobOrderId = null,
  paymobIntentionId = null,
  paymobTransactionId,
  amountPiastres,
  currency,
  requestIsTerminal = false,
  requestPaymentExpiresAt = null,
  dependencies,
}) {
  const deps = resolveDependencies(dependencies);
  const now = deps.now();
  const attempt = attemptId
    ? await deps.paymentAttemptModel.findById(attemptId)
    : await findSubstitutionPaymentAttemptByProviderRefs({
      merchantOrderId,
      paymobOrderId,
      paymobIntentionId,
      dependencies: deps,
    });
  if (!attempt) return { classification: "not_found", attempt: null };

  let receivedCurrency = null;
  try {
    receivedCurrency = normalizeCurrency(currency);
  } catch {
    // Webhook-originated values are untrusted. Treat malformed currency as a
    // rejected payment rather than exposing a validation path to the gateway.
    return { classification: "amount_or_currency_mismatch", attempt };
  }
  const expectedCurrency = normalizeCurrency(attempt.currency);
  if (
    Number(amountPiastres) !== Number(attempt.amountPiastres) ||
    receivedCurrency !== expectedCurrency
  ) {
    return { classification: "amount_or_currency_mismatch", attempt };
  }
  if (!normalizeString(paymobTransactionId)) {
    throw new ApiError("paymobTransactionId is required", 400);
  }

  const storedTransactionId = normalizeString(attempt.paymobTransactionId);
  if (storedTransactionId && storedTransactionId !== String(paymobTransactionId)) {
    return { classification: "duplicate_success_refund_required", attempt };
  }
  if (attempt.successAccepted) return { classification: "already_succeeded", attempt };

  const requestDeadline = requestPaymentExpiresAt
    ? normalizeFutureDate(requestPaymentExpiresAt, "requestPaymentExpiresAt")
    : null;
  const terminalOrLate =
    Boolean(requestIsTerminal) ||
    new Date(attempt.expiresAt).getTime() <= now.getTime() ||
    (requestDeadline && requestDeadline.getTime() <= now.getTime()) ||
    !ACTIVE_ATTEMPT_STATUSES.includes(attempt.status);

  const providerRefs = {
    paymobTransactionId: String(paymobTransactionId),
    ...(normalizeString(paymobOrderId) && { paymobOrderId: normalizeString(paymobOrderId) }),
    ...(normalizeString(paymobIntentionId) && { paymobIntentionId: normalizeString(paymobIntentionId) }),
  };

  if (terminalOrLate) {
    const late = await deps.paymentAttemptModel.findOneAndUpdate(
      {
        _id: getAttemptId(attempt),
        successAccepted: { $ne: true },
        paymobTransactionId: { $in: [null, String(paymobTransactionId)] },
      },
      {
        $set: {
          ...providerRefs,
          status: orderPaymentAttemptStatusEnum.LATE_SUCCESS_REFUND_REQUIRED,
          lateSuccessAt: now,
        },
      },
      { new: true },
    );
    return {
      classification: late ? "late_success_refund_required" : "already_processed",
      attempt: late ?? attempt,
    };
  }

  try {
    const accepted = await deps.paymentAttemptModel.findOneAndUpdate(
      {
        _id: getAttemptId(attempt),
        status: { $in: ACTIVE_ATTEMPT_STATUSES },
        successAccepted: { $ne: true },
        paymobTransactionId: { $in: [null, String(paymobTransactionId)] },
      },
      {
        $set: {
          ...providerRefs,
          status: orderPaymentAttemptStatusEnum.SUCCEEDED,
          successAccepted: true,
          succeededAt: now,
        },
        $unset: { initializationLeaseToken: 1, initializationLeaseExpiresAt: 1 },
      },
      { new: true },
    );
    if (accepted) return { classification: "accepted", attempt: accepted };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }

  const winningAttempt = await deps.paymentAttemptModel.findOne({
    substitutionRequest: attempt.substitutionRequest,
    successAccepted: true,
  });
  if (winningAttempt) {
    if (idsEqual(getAttemptId(winningAttempt), getAttemptId(attempt))) {
      return { classification: "already_succeeded", attempt: winningAttempt };
    }

    const lateConcurrentAttempt = await deps.paymentAttemptModel.findOneAndUpdate(
      {
        _id: getAttemptId(attempt),
        status: { $in: ACTIVE_ATTEMPT_STATUSES },
        successAccepted: { $ne: true },
        paymobTransactionId: { $in: [null, String(paymobTransactionId)] },
      },
      {
        $set: {
          ...providerRefs,
          status: orderPaymentAttemptStatusEnum.LATE_SUCCESS_REFUND_REQUIRED,
          lateSuccessAt: now,
        },
      },
      { new: true },
    );
    return {
      classification: lateConcurrentAttempt
        ? "another_attempt_success_refund_required"
        : "already_processed",
      attempt: lateConcurrentAttempt ?? winningAttempt,
    };
  }

  // The request can expire after the initial read but before the active-attempt
  // CAS above. Re-read its terminal attempt state and turn that paid callback
  // into a durable late-success refund instead of silently acknowledging it.
  const lateAfterExpiry = await deps.paymentAttemptModel.findOneAndUpdate(
    {
      _id: getAttemptId(attempt),
      status: {
        $in: [
          orderPaymentAttemptStatusEnum.FAILED,
          orderPaymentAttemptStatusEnum.SUPERSEDED,
          orderPaymentAttemptStatusEnum.EXPIRED,
        ],
      },
      successAccepted: { $ne: true },
      paymobTransactionId: { $in: [null, String(paymobTransactionId)] },
    },
    {
      $set: {
        ...providerRefs,
        status: orderPaymentAttemptStatusEnum.LATE_SUCCESS_REFUND_REQUIRED,
        lateSuccessAt: now,
      },
    },
    { new: true },
  );
  return {
    classification: lateAfterExpiry
      ? "late_success_refund_required"
      : "already_processed",
    attempt: lateAfterExpiry ?? attempt,
  };
}

export async function createOrFindRefundOperation({
  operationId = null,
  orderId,
  substitutionRequestId,
  paymentAttemptId = null,
  userId = null,
  guestId = null,
  method,
  amountPiastres,
  currency = DEFAULT_CURRENCY,
  originalTransactionId = null,
  session = null,
  dependencies,
}) {
  validateExclusiveOwner({ userId, guestId });
  if (!orderId || !substitutionRequestId || !["card", "manual", "wallet"].includes(method)) {
    throw new ApiError("Valid order, request, and refund method are required", 400);
  }
  const deps = resolveDependencies(dependencies);
  const desired = {
    operationId: normalizeString(operationId) || makeRefundOperationId({
      substitutionRequestId,
      paymentAttemptId,
      method,
      originalTransactionId,
      amountPiastres,
    }),
    order: orderId,
    substitutionRequest: substitutionRequestId,
    paymentAttempt: paymentAttemptId || undefined,
    user: userId || undefined,
    guestId: normalizeString(guestId) || undefined,
    method,
    amountPiastres: normalizePositivePiastres(amountPiastres),
    currency: normalizeCurrency(currency),
    originalTransactionId: normalizeString(originalTransactionId) || undefined,
    status: refundOperationStatusEnum.PENDING,
    nextAttemptAt: deps.now(),
  };
  const { refundOperationModel } = deps;
  const existing = await applySession(
    refundOperationModel.findOne({ operationId: desired.operationId }),
    session,
  );
  if (existing) {
    assertSameRefundIntent(existing, desired);
    return { operation: existing, created: false };
  }
  try {
    const created = session
      ? await refundOperationModel.create([desired], { session })
      : await refundOperationModel.create(desired);
    const operation = Array.isArray(created) ? created[0] : created;
    return { operation, created: true };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const duplicate = await applySession(
      refundOperationModel.findOne({ operationId: desired.operationId }),
      session,
    );
    if (!duplicate) throw error;
    assertSameRefundIntent(duplicate, desired);
    return { operation: duplicate, created: false };
  }
}

export async function ensureLateSuccessRefundOperation({
  attempt,
  originalTransactionId = null,
  session = null,
  dependencies,
}) {
  const deps = resolveDependencies(dependencies);
  if (
    !attempt ||
    attempt.status !==
      orderPaymentAttemptStatusEnum.LATE_SUCCESS_REFUND_REQUIRED
  ) {
    return { operation: null, created: false, skipped: true, attempt };
  }

  const transactionId =
    normalizeString(originalTransactionId) ||
    normalizeString(attempt.paymobTransactionId);
  if (!transactionId) {
    throw new ApiError(
      "Late substitution payment is missing its provider transaction",
      409,
    );
  }

  const result = await createOrFindRefundOperation({
    orderId: attempt.order,
    substitutionRequestId: attempt.substitutionRequest,
    paymentAttemptId: getAttemptId(attempt),
    userId: attempt.user || null,
    guestId: attempt.guestId || null,
    method: "card",
    amountPiastres: attempt.amountPiastres,
    currency: attempt.currency,
    originalTransactionId: transactionId,
    session,
    dependencies: deps,
  });

  const linked = await deps.paymentAttemptModel.findOneAndUpdate(
    {
      _id: getAttemptId(attempt),
      status: orderPaymentAttemptStatusEnum.LATE_SUCCESS_REFUND_REQUIRED,
    },
    { $set: { refundOperation: getId(result.operation) } },
    session ? { new: true, session } : { new: true },
  );

  return {
    ...result,
    attempt: linked ?? attempt,
    skipped: false,
  };
}

function boundedLimit(value, fallback = 25) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}

export async function reconcileLateSuccessRefundOperations({
  limit = 25,
  dependencies,
} = {}) {
  const deps = resolveDependencies(dependencies);
  const size = boundedLimit(limit);
  let query = deps.paymentAttemptModel.find({
    status: orderPaymentAttemptStatusEnum.LATE_SUCCESS_REFUND_REQUIRED,
    $or: [
      { refundOperation: { $exists: false } },
      { refundOperation: null },
    ],
  });
  if (typeof query.sort === "function") {
    query = query.sort({ lateSuccessAt: 1, _id: 1 });
  }
  if (typeof query.limit === "function") query = query.limit(size);
  const attempts = await query;
  const results = [];

  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    try {
      const result = await ensureLateSuccessRefundOperation({
        attempt,
        dependencies: deps,
      });
      results.push({ attemptId: getAttemptId(attempt), ...result });
    } catch (error) {
      results.push({ attemptId: getAttemptId(attempt), error });
    }
  }
  return results;
}

export async function claimRefundOperation({
  now = null,
  leaseMs = 60_000,
  dependencies,
}) {
  const deps = resolveDependencies(dependencies);
  const claimedAt = now ? normalizeFutureDate(now, "now") : deps.now();
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60_000) {
    throw new ApiError("leaseMs must be between 1000 and 900000", 400);
  }
  const leaseToken = deps.randomUUID();
  return deps.refundOperationModel.findOneAndUpdate(
    {
      $or: [
        {
          status: { $in: [refundOperationStatusEnum.PENDING, refundOperationStatusEnum.RETRYABLE] },
          nextAttemptAt: { $lte: claimedAt },
        },
        {
          status: refundOperationStatusEnum.PROCESSING,
          leaseExpiresAt: { $lte: claimedAt },
        },
      ],
    },
    {
      $set: {
        status: refundOperationStatusEnum.PROCESSING,
        leaseToken,
        leaseExpiresAt: new Date(claimedAt.getTime() + leaseMs),
      },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { nextAttemptAt: 1, createdAt: 1 } },
  );
}

export async function markRefundOperationSucceeded({
  operationId,
  leaseToken,
  providerRefundTransactionId = null,
  session = null,
  dependencies,
}) {
  const deps = resolveDependencies(dependencies);
  if (!normalizeString(leaseToken)) throw new ApiError("leaseToken is required", 400);
  return deps.refundOperationModel.findOneAndUpdate(
    {
      _id: operationId,
      status: refundOperationStatusEnum.PROCESSING,
      leaseToken: normalizeString(leaseToken),
    },
    {
      $set: {
        status: refundOperationStatusEnum.SUCCEEDED,
        completedAt: deps.now(),
        ...(normalizeString(providerRefundTransactionId) && {
          providerRefundTransactionId: normalizeString(providerRefundTransactionId),
        }),
      },
      $unset: { leaseToken: 1, leaseExpiresAt: 1, errorCode: 1, errorAt: 1 },
    },
    session ? { new: true, session } : { new: true },
  );
}

// The payment provider cannot be called inside a MongoDB transaction. Persist
// its accepted result first; if the following local transaction is interrupted,
// a later worker finalizes from this marker without issuing another refund.
export async function markRefundOperationProviderSucceeded({
  operationId,
  leaseToken,
  providerRefundTransactionId = null,
  session = null,
  dependencies,
}) {
  const deps = resolveDependencies(dependencies);
  if (!normalizeString(leaseToken)) throw new ApiError("leaseToken is required", 400);
  return deps.refundOperationModel.findOneAndUpdate(
    {
      _id: operationId,
      status: refundOperationStatusEnum.PROCESSING,
      leaseToken: normalizeString(leaseToken),
      providerRefundSucceededAt: { $exists: false },
    },
    {
      $set: {
        providerRefundSucceededAt: deps.now(),
        ...(normalizeString(providerRefundTransactionId) && {
          providerRefundTransactionId: normalizeString(providerRefundTransactionId),
        }),
      },
    },
    session ? { new: true, session } : { new: true },
  );
}

export async function markRefundOperationFailure({
  operationId,
  leaseToken,
  errorCode = "REFUND_FAILED",
  retryAt = null,
  manualRequired = false,
  session = null,
  dependencies,
}) {
  const deps = resolveDependencies(dependencies);
  if (!normalizeString(leaseToken)) throw new ApiError("leaseToken is required", 400);
  const now = deps.now();
  const nextAttemptAt = retryAt ? normalizeFutureDate(retryAt, "retryAt") : new Date(now.getTime() + 5 * 60_000);
  return deps.refundOperationModel.findOneAndUpdate(
    {
      _id: operationId,
      status: refundOperationStatusEnum.PROCESSING,
      leaseToken: normalizeString(leaseToken),
    },
    {
      $set: {
        status: manualRequired
          ? refundOperationStatusEnum.MANUAL_REQUIRED
          : refundOperationStatusEnum.RETRYABLE,
        nextAttemptAt,
        errorCode: sanitizeErrorCode({ code: errorCode }),
        errorAt: now,
      },
      $unset: { leaseToken: 1, leaseExpiresAt: 1 },
    },
    session ? { new: true, session } : { new: true },
  );
}

export const substitutionPaymentInternals = Object.freeze({
  makeMerchantOrderId,
  makeRefundOperationId,
  sanitizeErrorCode,
  normalizePositivePiastres,
  normalizeCurrency,
  boundedLimit,
});
