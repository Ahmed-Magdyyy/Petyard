import { Router } from "express";
import {
  handlePaymobWebhookPost,
  handlePaymobWebhookGet,
  getUserSavedCards,
  deleteUserSavedCard,
} from "./payment.controller.js";
import { protect } from "../auth/auth.middleware.js";
import { savedCardIdValidator } from "./payment.validators.js";

const router = Router();

// Paymob webhooks — no auth required, verified via HMAC
router.post("/webhook", handlePaymobWebhookPost); // server-to-server callback
router.get("/webhook", handlePaymobWebhookGet);   // browser redirect callback

// Saved cards — authenticated users only
router.use("/cards", protect);
router.get("/cards", getUserSavedCards);
router.delete("/cards/:id", savedCardIdValidator, deleteUserSavedCard);

export default router;
