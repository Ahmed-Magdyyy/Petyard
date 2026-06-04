import rateLimit from "express-rate-limit";

// Extract the real client IP from proxy headers.
// Falls back through: X-Forwarded-For → X-Real-IP → req.ip → req.socket.remoteAddress
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    // X-Forwarded-For can be comma-separated; the first is the real client
    return forwarded.split(",")[0].trim();
  }
  return (
    req.headers["x-real-ip"] ||
    req.ip ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

// ── Strict auth limiter — login, signup, verify, reset ───────────────────────
export const strictAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  keyGenerator: getClientIp,
  message: {
    status: "error",
    message: "Too many attempts, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── OTP limiter — sending OTPs / reset codes ─────────────────────────────────
export const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  keyGenerator: getClientIp,
  message: {
    status: "error",
    message: "Too many OTP requests, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Payment / financial limiter — order creation, loyalty redeem ──────────────
export const paymentLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 5,
  keyGenerator: getClientIp,
  message: {
    status: "error",
    message: "Too many requests, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Guest limiter — unauthenticated routes ───────────────────────────────
export const guestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1500,
  keyGenerator: getClientIp,
  message: {
    status: "error",
    message: "Too many requests, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Global API limiter — catch-all for all routes ────────────────────────
export const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 2000,
  keyGenerator: getClientIp,
  message: {
    status: "error",
    message: "Too many requests, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
