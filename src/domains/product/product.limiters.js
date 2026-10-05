import rateLimit from "express-rate-limit";

export const productBatchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ status: "fail", message: "Too many product batch requests." }),
});
