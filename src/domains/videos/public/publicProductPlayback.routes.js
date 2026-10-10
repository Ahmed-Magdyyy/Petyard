import { Router } from "express";
import { optionalProtect } from "../../auth/auth.middleware.js";
import { createPublicProductPlaybackController } from "./publicProductPlayback.controller.js";


export function createPublicProductPlaybackRouter({
  optionalAccess = optionalProtect, getService
} = {}) {
  const router = Router();
  const controller = createPublicProductPlaybackController({ getService });
  router.get("/:id/playback", optionalAccess, controller.grantPlayback);
  return router;
}

export default createPublicProductPlaybackRouter();
