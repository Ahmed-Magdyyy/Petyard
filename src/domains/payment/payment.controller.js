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
  const paymobOrderId = req.query.id; // Usually mapped to `id` in GET redirect

  console.log(
    `[Paymob Redirect] success=${req.query.success} pending=${req.query.pending}` +
      ` merchantOrder=${merchantOrderId}`,
  );

  // Fallback: If user cancelled and POST webhook was missed or delayed, fail the order immediately.
  if (!isSuccess && (merchantOrderId || paymobOrderId)) {
    try {
      const order = await findOrderByIds(merchantOrderId, paymobOrderId);
      if (order && order.status === "awaiting_payment") {
        await failOrderPaymentService(order._id);
        console.log(`[Paymob Redirect] Marked order ${merchantOrderId} as failed via GET fallback`);
      }
    } catch (err) {
      console.error("[Paymob Redirect] Error in failure fallback:", err.message);
    }
  }

  // Return a web page that tries to auto-close the webview, replacing "Redirect acknowledged" JSON.
  res.status(200).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment ${isSuccess ? 'Successful' : 'Failed'}</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f9fafb; color: #1f2937; text-align: center; padding: 20px; }
        .card { background: white; padding: 40px 30px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05); max-width: 400px; width: 100%; }
        h1 { margin-top: 0; font-size: 24px; color: ${isSuccess ? '#10b981' : '#ef4444'}; }
        p { color: #6b7280; margin-bottom: 24px; line-height: 1.5; }
        .spinner { width: 40px; height: 40px; border: 3px solid rgba(0,0,0,0.1); border-radius: 50%; border-top-color: #3b82f6; animation: spin 1s ease-in-out infinite; margin: 0 auto 20px; }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="spinner"></div>
        <h1>Payment ${isSuccess ? 'Successful' : 'Failed'}</h1>
        <p>Redirecting you back to the app...<br><br><small>If you are not redirected automatically, please press the back button or close this screen to continue.</small></p>
      </div>
      <script>
        // Attempt to close the webview automatically
        setTimeout(() => {
          try { window.close(); } catch (e) {}
          // For Flutter WebViews that inject a JavascriptChannel named "PaymobSDK" or "Print"
          try { if (window.PaymobSDK) window.PaymobSDK.postMessage(JSON.stringify({ success: ${isSuccess} })); } catch(e) {}
          try { if (window.Print) window.Print.postMessage('close'); } catch(e) {}
        }, 800);
      </script>
    </body>
    </html>
  `);
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
