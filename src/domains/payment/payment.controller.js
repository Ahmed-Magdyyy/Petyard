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

  // Debug: log full TOKEN payload to identify available fields
  console.log("[Paymob Webhook] TOKEN payload:", JSON.stringify(tokenObj));

  const token = tokenObj.token;
  const maskedPan = tokenObj.masked_pan || "";
  const cardSubtype = tokenObj.card_subtype || "";
  const orderId = tokenObj.order_id || tokenObj.order?.id;
  const expiryMonth = tokenObj.expiry_month || tokenObj.card_expiry_month || null;
  const expiryYear = tokenObj.expiry_year || tokenObj.card_expiry_year || null;

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
    expiryMonth,
    expiryYear,
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
  const isSuccess = req.query.success === "true";
  const merchantOrderId = req.query.merchant_order_id;
  const paymobOrderId = req.query.id;

  console.log(
    `[Paymob Redirect] success=${req.query.success} pending=${req.query.pending}` +
      ` merchantOrder=${merchantOrderId}`,
  );

  // Fallback: mark order as cancelled if POST webhook hasn't arrived yet.
  if (!isSuccess && (merchantOrderId || paymobOrderId)) {
    try {
      const order = await findOrderByIds(merchantOrderId, paymobOrderId);
      if (order && order.status === "awaiting_payment") {
        await failOrderPaymentService(order._id);
        console.log(`[Paymob Redirect] Marked order ${merchantOrderId} as cancelled via GET fallback`);
      }
    } catch (err) {
      console.error("[Paymob Redirect] Error in failure fallback:", err.message);
    }
  }

  const icon = isSuccess ? "✓" : "✕";
  const iconColor = isSuccess ? "#22c55e" : "#ef4444";
  const title = isSuccess ? "Payment Successful" : "Payment Failed";
  const message = isSuccess
    ? "Your payment was completed successfully."
    : "Your payment was not completed.";

  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', sans-serif;
      background: #f8f8f8;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #fff;
      border-radius: 20px;
      padding: 48px 32px;
      text-align: center;
      max-width: 360px;
      width: 100%;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    .icon-circle {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      background: ${iconColor}18;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      font-size: 32px;
      color: ${iconColor};
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      color: #111;
      margin-bottom: 10px;
    }
    p {
      font-size: 14px;
      color: #6b7280;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-circle">${icon}</div>
    <h1>${title}</h1>
    <p>${message}<br>Press your phone's back button to return to the app.</p>
  </div>
</body>
</html>`);
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
