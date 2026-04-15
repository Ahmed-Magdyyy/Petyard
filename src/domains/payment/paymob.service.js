import crypto from "crypto";
import { ApiError } from "../../shared/utils/ApiError.js";

const PAYMOB_BASE_URL = "https://accept.paymob.com";

// ─── Configuration ──────────────────────────────────────────────────────────

function getConfig() {
  return {
    apiKey: process.env.PAYMOB_API_KEY,
    secretKey: process.env.PAYMOB_SECRET_KEY,
    publicKey: process.env.PAYMOB_PUBLIC_KEY,
    integrationId: Number(process.env.PAYMOB_INTEGRATION_ID),
    hmacSecret: process.env.PAYMOB_HMAC,
    webhookUrl: process.env.PAYMOB_WEBHOOK_URL || null,
  };
}

export function getPublicKey() {
  return getConfig().publicKey;
}

// ─── Legacy Auth Token (required by refund endpoint) ────────────────────────

let _cachedAuthToken = null;
let _cachedAuthTokenExpiresAt = 0;

async function getPaymobAuthToken() {
  if (_cachedAuthToken && Date.now() < _cachedAuthTokenExpiresAt) {
    return _cachedAuthToken;
  }

  const { apiKey } = getConfig();
  if (!apiKey) {
    throw new ApiError("Paymob API key is not configured", 500);
  }

  const response = await fetch(`${PAYMOB_BASE_URL}/api/auth/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("[Paymob] Auth token error:", response.status, errorBody);
    throw new ApiError("Failed to authenticate with payment gateway", 502);
  }

  const data = await response.json();
  _cachedAuthToken = data.token;
  // Paymob tokens last ~1 hour; cache for 50 minutes
  _cachedAuthTokenExpiresAt = Date.now() + 50 * 60 * 1000;

  return _cachedAuthToken;
}

// ─── Refund Transaction ─────────────────────────────────────────────────────

export async function refundTransaction({ transactionId, amountCents }) {
  const authToken = await getPaymobAuthToken();

  const response = await fetch(
    `${PAYMOB_BASE_URL}/api/acceptance/void_refund/refund`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_token: authToken,
        transaction_id: transactionId,
        amount_cents: amountCents,
      }),
    },
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("[Paymob] Refund API error:", response.status, errorBody);
    throw new ApiError("Failed to process card refund", 502);
  }

  const data = await response.json();

  if (!data.success && data.success !== undefined) {
    console.error("[Paymob] Refund rejected:", data);
    throw new ApiError("Card refund was rejected by payment gateway", 502);
  }

  return {
    refundTransactionId: data.id ? String(data.id) : null,
    success: data.success !== false,
  };
}

// ─── Create Payment Intention (v2 API) ──────────────────────────────────────

export async function createPaymentIntention({
  merchantOrderId,
  amountCents,
  currency = "EGP",
  billingData,
  items = [],
  cardTokens = [],
}) {
  const config = getConfig();

  if (!config.secretKey || !config.integrationId) {
    throw new ApiError("Payment gateway is not configured", 500);
  }

  const body = {
    amount: amountCents,
    currency,
    payment_methods: [config.integrationId],
    billing_data: {
      first_name: billingData.firstName || "N/A",
      last_name: billingData.lastName || "N/A",
      email: billingData.email || "na@na.com",
      phone_number: billingData.phone || "N/A",
    },
    items: items.map((item) => ({
      name: item.name || "Product",
      amount: item.amountCents,
      quantity: item.quantity || 1,
    })),
    merchant_order_id: merchantOrderId,
    special_reference: merchantOrderId,
    extras: { merchant_order_id: merchantOrderId },
    ...(config.webhookUrl && { notification_url: config.webhookUrl }),
    ...(config.webhookUrl && { redirection_url: config.webhookUrl }),
    ...(cardTokens && cardTokens.length > 0 && { card_tokens: cardTokens }),
  };

  const response = await fetch(`${PAYMOB_BASE_URL}/v1/intention/`, {
    method: "POST",
    headers: {
      Authorization: `Token ${config.secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("[Paymob] Intention API error:", response.status, errorBody);
    throw new ApiError("Failed to initialize payment", 502);
  }

  const data = await response.json();

  return {
    intentionId: data.intention_id || data.id,
    clientSecret: data.client_secret,
    paymobOrderId: data.intention_order_id
      ? String(data.intention_order_id)
      : null,
  };
}

// ─── Webhook HMAC Verification ──────────────────────────────────────────────

/**
 * Fields used to compute the HMAC digest, in the exact order
 * required by Paymob's transaction callback specification.
 */
const HMAC_FIELDS = [
  "amount_cents",
  "created_at",
  "currency",
  "error_occured",
  "has_parent_transaction",
  "id",
  "integration_id",
  "is_3d_secure",
  "is_auth",
  "is_capture",
  "is_refunded",
  "is_standalone_payment",
  "is_voided",
  "order.id",
  "owner",
  "pending",
  "source_data.pan",
  "source_data.sub_type",
  "source_data.type",
  "success",
];

function getNestedValue(obj, path) {
  return path
    .split(".")
    .reduce((curr, key) => (curr != null ? curr[key] : undefined), obj);
}

export function verifyWebhookHmac(transactionObj, receivedHmac) {
  const config = getConfig();

  if (!config.hmacSecret) {
    console.error("[Paymob] HMAC secret not configured");
    return false;
  }

  const concatenated = HMAC_FIELDS.map((field) => {
    const value = getNestedValue(transactionObj, field);
    return value != null ? String(value) : "";
  }).join("");

  const computed = crypto
    .createHmac("sha512", config.hmacSecret)
    .update(concatenated)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, "hex"),
      Buffer.from(receivedHmac, "hex"),
    );
  } catch {
    return false;
  }
}

// ─── Webhook Payload Extraction ─────────────────────────────────────────────

export function extractTransactionData(webhookBody) {
  const obj =
    webhookBody?.transaction || webhookBody?.obj || webhookBody;

  return {
    transactionId: obj.id != null ? String(obj.id) : "",
    merchantOrderId:
      obj.merchant_order_id ||
      obj.order?.merchant_order_id ||
      obj.special_reference ||
      obj.payment_key_claims?.extra?.merchant_order_id ||
      null,
    paymobOrderId: obj.order?.id ? String(obj.order.id) : null,
    success: obj.success === true,
    pending: obj.pending === true,
    amountCents: obj.amount_cents,
    currency: obj.currency,
    sourceData: {
      type: obj.source_data?.type || null,
      pan: obj.source_data?.pan || null,
      subType: obj.source_data?.sub_type || null,
    },
    cardToken: obj.token || obj.data?.token || null,
  };
}

// ─── Amount Verification ───────────────────────────────────────────────────

export function verifyPaymentAmount(webhookAmountCents, expectedAmountCents) {
  return Number(webhookAmountCents) === Number(expectedAmountCents);
}

// ─── Build transaction object from GET query params ─────────────────────────

export function buildTransactionFromQuery(query) {
  return {
    id: query.id,
    pending: query.pending === "true",
    amount_cents: query.amount_cents,
    success: query.success === "true",
    is_auth: query.is_auth === "true",
    is_capture: query.is_capture === "true",
    is_standalone_payment: query.is_standalone_payment === "true",
    is_voided: query.is_voided === "true",
    is_refunded: query.is_refunded === "true",
    is_3d_secure: query.is_3d_secure === "true",
    integration_id: query.integration_id,
    has_parent_transaction: query.has_parent_transaction === "true",
    order: { id: query.order },
    created_at: query.created_at,
    currency: query.currency,
    error_occured: query.error_occured === "true",
    owner: query.owner,
    source_data: {
      type: query["source_data.type"],
      pan: query["source_data.pan"],
      sub_type: query["source_data.sub_type"],
    },
    merchant_order_id:
      query.merchant_order_id || query["order.merchant_order_id"] || null,
    data: {
      message: query["data.message"],
    },
  };
}
