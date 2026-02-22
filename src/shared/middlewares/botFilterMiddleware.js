import { ApiError } from "../utils/ApiError.js";

// Allowlisted route prefixes — only these are legitimate app routes.
// Everything else that reaches the catch-all is bot/scanner noise.
const ALLOWED_ROUTE_PREFIXES = [
  "/api/v1/",
];

/**
 * Catch-all middleware for unmatched routes.
 * Uses an ALLOWLIST approach: only routes starting with known prefixes
 * get logged as genuine "route not found" errors.
 * Everything else (bot probes, scanners, random paths) is silently rejected.
 */
export const unmatchedRouteHandler = (req, res, next) => {
  const url = req.originalUrl;

  // Check if the route belongs to a legitimate API prefix
  const isLegitimate = ALLOWED_ROUTE_PREFIXES.some((prefix) =>
    url.startsWith(prefix)
  );

  if (isLegitimate) {
    // This is a real API route that doesn't exist — log it
    return next(new ApiError(`can't find this route: ${url}`, 400));
  }

  // Everything else is bot/scanner noise — reject silently
  return res.status(404).json({ status: "fail", message: "Not found" });
};
