import { Router } from "express";
import { protectUserOrGuest, protect, allowedTo, enabledControls as requireControl } from "../../auth/auth.middleware.js";
import { roles, enabledControls } from "../../../shared/constants/enums.js";
import { createVideoAnalyticsController } from "./videoAnalytics.controller.js";
import { createPlaybackSessionLimiter, createAnalyticsEventLimiter } from "./videoAnalytics.limiters.js";

export function createVideoAnalyticsRouter({ getService } = {}) {
  const router = Router();
  const controller = createVideoAnalyticsController({ getService });
  router.get("/reports/daily", protect, allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
    requireControl(enabledControls.ANALYTICS), controller.listDailyReport);
  router.post("/events", createAnalyticsEventLimiter(), protectUserOrGuest, controller.ingestEvents);
  router.post("/playback-sessions", createPlaybackSessionLimiter(), protectUserOrGuest,
    controller.issueSession);
  return router;
}

export default createVideoAnalyticsRouter();
