import { Router } from "express";
import { createBunnyStreamWebhookController } from "./bunnyStreamWebhook.controller.js";

export function createBunnyStreamWebhookRouter({ getService } = {}) {
  const router = Router();
  const controller = createBunnyStreamWebhookController({ getService });
  // Server-to-server authentication is the signed raw body, not a user JWT.
  router.post("/webhook", controller.receive);
  return router;
}

export default createBunnyStreamWebhookRouter();
