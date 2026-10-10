import { Router } from "express";
import { optionalProtect, protectUserOrGuest } from "../../auth/auth.middleware.js";
import { createPublicVideoController } from "./publicVideo.controller.js";
import { createPlayerErrorLimiter } from "./publicVideo.limiters.js";


export function createPublicVideoRouter({
  optionalAccess = optionalProtect, saveAccess = protectUserOrGuest,
  getService, getPlaybackService
} = {}) {
  const router = Router();
  const controller = createPublicVideoController({ getService, getPlaybackService });
  router.get("/youtube", optionalAccess, controller.listYouTube);
  router.get("/feed", optionalAccess, controller.listFeed);
  router.get("/saved", saveAccess, controller.listSaved);
  router.put("/saved/:videoId", saveAccess, controller.save);
  router.delete("/saved/:videoId", saveAccess, controller.unsave);
  router.post("/:id/player-errors", createPlayerErrorLimiter(), saveAccess, controller.reportPlayerError);
  router.get("/:id/playback", optionalAccess, controller.grantPlayback);
  router.get("/:id", optionalAccess, controller.getVideo);
  return router;
}

export default createPublicVideoRouter();
