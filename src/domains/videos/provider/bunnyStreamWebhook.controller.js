import asyncHandler from "express-async-handler";
import { getBunnyStreamWebhookService } from "./bunnyStreamWebhook.service.js";

export function createBunnyStreamWebhookController({ getService = getBunnyStreamWebhookService } = {}) {
  return Object.freeze({
    receive: asyncHandler(async (req, res) => {
      const service = await getService();
      await service.receive({ rawBody: req.bunnyStreamRawBody, headers: req.headers });
      res.set("Cache-Control", "private, no-store");
      // Do not reveal whether a target exists, its operation ID or queue state.
      res.status(202).json({ received: true });
    }),
  });
}
