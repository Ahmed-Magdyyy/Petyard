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

// ─── Shared webhook processing logic ────────────────────────────────────────

async function processWebhook(transactionObj, receivedHmac, fullBody) {
  if (!receivedHmac || !transactionObj) {
    console.warn("[Paymob Webhook] Missing HMAC or transaction object");
    return { status: 400, message: "Invalid webhook payload" };
  }

  const isValid = verifyWebhookHmac(transactionObj, receivedHmac);
  if (!isValid) {
    console.warn("[Paymob Webhook] HMAC verification failed");
    return { status: 401, message: "HMAC verification failed" };
  }

  const txData = extractTransactionData(fullBody);

  console.log(
    `[Paymob Webhook] txn=${txData.transactionId} success=${txData.success} pending=${txData.pending} merchantOrder=${txData.merchantOrderId} paymobOrder=${txData.paymobOrderId}`,
  );

  if (txData.pending) {
    return { status: 200, message: "Pending transaction acknowledged" };
  }

  // Look up our order: try merchantOrderId (orderNumber) first, then paymobOrderId
  let order = null;
  if (txData.merchantOrderId) {
    order = await OrderModel.findOne({ orderNumber: txData.merchantOrderId });
  }
  if (!order && txData.paymobOrderId) {
    order = await OrderModel.findOne({ paymobOrderId: txData.paymobOrderId });
  }

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
      `[Paymob Webhook] SECURITY: Amount mismatch for order ${order.orderNumber} — expected ${expectedAmountCents}, received ${txData.amountCents}. Full payload: ${JSON.stringify(txData)}`,
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

  if (txData.success) {
    await confirmOrderPaymentService({
      orderId: order._id,
      paymobTransactionId: txData.transactionId,
      paymobOrderId: txData.paymobOrderId,
    });

    // Save card token for future payments (fire-and-forget)
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

// ─── POST webhook (server-to-server callback) ──────────────────────────────

export const handlePaymobWebhookPost = asyncHandler(async (req, res) => {
  // Paymob sends several webhook types (TRANSACTION, ORDER, TOKEN, etc.)
  // We only care about TRANSACTION — the others have different payload
  // structures and their HMAC fields don't match ours.
  const webhookType = req.body.type;
  if (webhookType && webhookType !== "TRANSACTION") {
    console.log(
      `[Paymob Webhook] Ignoring non-TRANSACTION webhook type: ${webhookType}`,
    );
    return res.status(200).json({ message: `${webhookType} acknowledged` });
  }

  const receivedHmac = req.body.hmac || req.query.hmac;
  const transactionObj = req.body.transaction || req.body.obj || req.body;

  const result = await processWebhook(transactionObj, receivedHmac, req.body);
  res.status(result.status).json({ message: result.message });
});

// ─── GET webhook (browser redirect callback) ────────────────────────────────
// NOTE: The GET redirect is for UX only — the POST webhook is the source of
// truth for payment confirmation. Paymob's GET redirect HMAC uses a different
// computation, so we intentionally skip HMAC verification here and just show
// the user a friendly result page based on the query parameters.

export const handlePaymobWebhookGet = asyncHandler(async (req, res) => {
  console.log(
    `[Paymob Redirect] success=${req.query.success} pending=${req.query.pending} merchantOrder=${req.query.merchant_order_id}`,
  );

  // Flutter app intercepts this redirect URL and reads query params natively.
  // Just return 200 to avoid errors in logs.
  res.status(200).json({ message: "Redirect acknowledged" });
});

// ─── Saved Cards ─────────────────────────────────────────────────────────────

export const getUserSavedCards = asyncHandler(async (req, res) => {
  const cards = await getUserSavedCardsService(req.user._id);
  res.status(200).json({ data: cards });
});

export const deleteUserSavedCard = asyncHandler(async (req, res) => {
  await deleteUserSavedCardService(req.user._id, req.params.id);
  res.status(200).json({ message: "Card deleted" });
});
