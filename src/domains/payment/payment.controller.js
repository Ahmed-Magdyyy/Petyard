import asyncHandler from "express-async-handler";
import {
  verifyWebhookHmac,
  extractTransactionData,
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

// ─── Paymob Webhook ─────────────────────────────────────────────────────────

export const handlePaymobWebhook = asyncHandler(async (req, res) => {
  const receivedHmac = req.query.hmac;
  const transactionObj = req.body?.obj || req.body;

  if (!receivedHmac || !transactionObj) {
    console.warn("[Paymob Webhook] Missing HMAC or transaction object");
    return res.status(400).json({ message: "Invalid webhook payload" });
  }

  const isValid = verifyWebhookHmac(transactionObj, receivedHmac);
  if (!isValid) {
    console.warn("[Paymob Webhook] HMAC verification failed");
    return res.status(401).json({ message: "HMAC verification failed" });
  }

  const txData = extractTransactionData(req.body);

  console.log(
    `[Paymob Webhook] txn=${txData.transactionId} success=${txData.success} pending=${txData.pending} order=${txData.merchantOrderId}`,
  );

  // Acknowledge pending transactions without further processing
  if (txData.pending) {
    return res.status(200).json({ message: "Pending transaction acknowledged" });
  }

  if (!txData.merchantOrderId) {
    console.warn("[Paymob Webhook] No merchant_order_id in transaction");
    return res.status(200).json({ message: "No merchant order ID" });
  }

  const order = await OrderModel.findOne({
    orderNumber: txData.merchantOrderId,
  });

  if (!order) {
    console.warn(
      `[Paymob Webhook] Order not found: ${txData.merchantOrderId}`,
    );
    return res.status(200).json({ message: "Order not found" });
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

  res.status(200).json({ message: "Webhook processed" });
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
