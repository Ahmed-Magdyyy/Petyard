import rateLimit from "express-rate-limit";

export function createPlayerErrorLimiter() {
  // ponytail: per-process IP limit, matching existing project limiters; use a
  // shared limiter store for multiple API instances. Durable alert dedupe
  // remains independent of this in-memory request limit.
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { status: "fail", error: [{ code: "VIDEO_REPORT_RATE_LIMITED" }],
      message: "Too many player error reports. Please try again later." },
  });
}
