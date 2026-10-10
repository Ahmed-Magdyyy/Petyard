import rateLimit from "express-rate-limit";

function analyticsLimiter(limit) {
  // ponytail: per-process IP ceiling, consistent with existing API limiters;
  // use a shared store if distributed limiting becomes necessary.
  return rateLimit({ windowMs: 60 * 1000, limit,
    standardHeaders: true, legacyHeaders: false,
    message: { status: "fail", error: [{ code: "VIDEO_ANALYTICS_RATE_LIMITED" }],
      message: "Too many analytics requests. Please try again later." } });
}

export const createPlaybackSessionLimiter = () => analyticsLimiter(120);
export const createAnalyticsEventLimiter = () => analyticsLimiter(60);
