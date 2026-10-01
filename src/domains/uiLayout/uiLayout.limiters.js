import rateLimit from "express-rate-limit";

function previewLimiter(limit, message) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: {
      code: "UI_PREVIEW_RATE_LIMITED", message, request_id: req.requestId,
    } }),
  });
}

export const previewReadLimiter = previewLimiter(60, "Too many preview requests.");
export const previewCreateLimiter = previewLimiter(30, "Too many previews created.");
