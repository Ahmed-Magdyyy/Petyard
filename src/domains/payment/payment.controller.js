import asyncHandler from "express-async-handler";
import {
  verifyWebhookHmac,
  extractTransactionData,
  verifyPaymentAmount,
} from "./paymob.service.js";
import {
  confirmOrderPaymentService,
  failOrderPaymentService,
} from "../order/order.service.js";
import {
  getUserSavedCardsService,
  deleteUserSavedCardService,
  saveCardFromTransaction,
} from "./savedCard.service.js";
import { OrderModel } from "../order/order.model.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Find an order by merchantOrderId (orderNumber) or paymobOrderId.
 */
async function findOrderByIds(merchantOrderId, paymobOrderId) {
  let order = null;
  if (merchantOrderId) {
    order = await OrderModel.findOne({ orderNumber: merchantOrderId });
  }
  if (!order && paymobOrderId) {
    order = await OrderModel.findOne({ paymobOrderId: String(paymobOrderId) });
  }
  return order;
}

// ─── TRANSACTION webhook logic ──────────────────────────────────────────────

async function handleTransaction(transactionObj, receivedHmac, fullBody) {
  if (!receivedHmac || !transactionObj) {
    console.warn("[Paymob Webhook] Missing HMAC or transaction object");
    return { status: 400, message: "Invalid webhook payload" };
  }

  if (!verifyWebhookHmac(transactionObj, receivedHmac)) {
    console.warn("[Paymob Webhook] HMAC verification failed");
    return { status: 401, message: "HMAC verification failed" };
  }

  const txData = extractTransactionData(fullBody);

  console.log(
    `[Paymob Webhook] txn=${txData.transactionId} success=${txData.success}` +
      ` pending=${txData.pending} merchantOrder=${txData.merchantOrderId}` +
      ` paymobOrder=${txData.paymobOrderId}` +
      ` cardToken=${txData.cardToken ? "present" : "absent"}`,
  );

  if (txData.pending) {
    return { status: 200, message: "Pending transaction acknowledged" };
  }

  const order = await findOrderByIds(
    txData.merchantOrderId,
    txData.paymobOrderId,
  );

  if (!order) {
    console.warn(
      `[Paymob Webhook] Order not found: merchant=${txData.merchantOrderId} paymob=${txData.paymobOrderId}`,
    );
    return { status: 200, message: "Order not found" };
  }

  // ── Amount verification ──
  const expectedAmountCents = Math.round(order.total * 100);
  if (!verifyPaymentAmount(txData.amountCents, expectedAmountCents)) {
    console.error(
      `[Paymob Webhook] SECURITY: Amount mismatch for order ${order.orderNumber}` +
        ` — expected ${expectedAmountCents}, received ${txData.amountCents}`,
    );

    order.history = Array.isArray(order.history) ? order.history : [];
    order.history.push({
      at: new Date(),
      description: `SECURITY: Amount mismatch — expected ${expectedAmountCents}, received ${txData.amountCents}`,
      visibleToUser: false,
    });
    await order.save();

    return { status: 200, message: "Amount mismatch — flagged for review" };
  }

  // ── Confirm or fail ──
  if (txData.success) {
    await confirmOrderPaymentService({
      orderId: order._id,
      paymobTransactionId: txData.transactionId,
      paymobOrderId: txData.paymobOrderId,
    });

    // Save card token if present in TRANSACTION payload (fire-and-forget)
    if (order.user && txData.cardToken) {
      saveCardFromTransaction(order.user, txData).catch((err) =>
        console.error("[Paymob Webhook] Failed to save card:", err.message),
      );
    }
  } else {
    await failOrderPaymentService(order._id);
  }

  return { status: 200, message: "Webhook processed" };
}

// ─── TOKEN webhook logic ────────────────────────────────────────────────────

async function handleTokenWebhook(body) {
  const tokenObj = body.obj || {};
  const token = tokenObj.token;
  const maskedPan = tokenObj.masked_pan || "";
  const cardSubtype = tokenObj.card_subtype || "";
  const orderId = tokenObj.order_id || tokenObj.order?.id;

  if (!token || !orderId) {
    console.log("[Paymob Webhook] TOKEN webhook missing token or order_id");
    return;
  }

  const order = await findOrderByIds(null, orderId);

  if (!order?.user) {
    console.log(
      `[Paymob Webhook] TOKEN — no order/user found for order_id=${orderId}`,
    );
    return;
  }

  const lastFour = maskedPan.slice(-4) || "";

  saveCardFromTransaction(order.user, {
    cardToken: token,
    sourceData: { pan: lastFour, subType: cardSubtype },
  }).catch((err) =>
    console.error(
      "[Paymob Webhook] Failed to save card from TOKEN:",
      err.message,
    ),
  );

  console.log(
    `[Paymob Webhook] TOKEN processed — saving card for order ${orderId}`,
  );
}

// ─── POST webhook (server-to-server callback) ──────────────────────────────

export const handlePaymobWebhookPost = asyncHandler(async (req, res) => {
  const webhookType = req.body.type;

  // Card-token webhook — save card for future payments
  if (webhookType === "TOKEN") {
    await handleTokenWebhook(req.body);
    return res.status(200).json({ message: "TOKEN processed" });
  }

  // Ignore other non-TRANSACTION types (ORDER, DELIVERY, etc.)
  if (webhookType && webhookType !== "TRANSACTION") {
    console.log(
      `[Paymob Webhook] Ignoring webhook type: ${webhookType}`,
    );
    return res.status(200).json({ message: `${webhookType} acknowledged` });
  }

  // TRANSACTION webhook — process payment
  const receivedHmac = req.body.hmac || req.query.hmac;
  const transactionObj = req.body.transaction || req.body.obj || req.body;

  const result = await handleTransaction(transactionObj, receivedHmac, req.body);
  res.status(result.status).json({ message: result.message });
});

// ─── GET webhook (browser redirect) ────────────────────────────────────────
// The POST webhook is the source of truth. The GET redirect is for UX only —
// Flutter intercepts the URL and reads query params natively.

export const handlePaymobWebhookGet = asyncHandler(async (req, res) => {
  console.log(
    `[Paymob Redirect] success=${req.query.success} pending=${req.query.pending}` +
      ` merchantOrder=${req.query.merchant_order_id}`,
  );

  res.status(200).json({ message: "Redirect acknowledged" });
});

// ─── Saved Cards ────────────────────────────────────────────────────────────

export const getUserSavedCards = asyncHandler(async (req, res) => {
  const cards = await getUserSavedCardsService(req.user._id);
  res.status(200).json({ data: cards });
});

export const deleteUserSavedCard = asyncHandler(async (req, res) => {
  await deleteUserSavedCardService(req.user._id, req.params.id);
  res.status(200).json({ message: "Card deleted" });
});
