import { Router } from "express";
import {
  handlePaymobWebhookPost,
  handlePaymobWebhookGet,
} from "./payment.controller.js";

const router = Router();

// Paymob webhooks — no auth required, verified via HMAC
router.post("/webhook", handlePaymobWebhookPost); // server-to-server callback
router.get("/webhook", handlePaymobWebhookGet);   // browser redirect callback

export default router;
