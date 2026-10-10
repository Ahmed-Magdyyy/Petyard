import asyncHandler from "express-async-handler";

import { getPublicProductPlaybackService } from "./publicProductPlayback.service.js";

export function createPublicProductPlaybackController({
  getService = getPublicProductPlaybackService
} = {}) {
  return Object.freeze({
    grantPlayback: asyncHandler(async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const application = await getService();
      const data = await application.grant({ id: req.params.id });
      res.status(200).json({ data });
    }),
  });
}
