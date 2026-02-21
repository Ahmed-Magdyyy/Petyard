import { ApiError } from "../utils/ApiError.js";

// Known bot/scanner paths — respond silently without logging
const IGNORED_ROUTE_PATTERNS = [
  /^\/(\\.env|\\.git|\\.aws|\\.ssh|\\.DS_Store)/i,
  /^\/(wp-admin|wp-login|wp-content|wp-includes|wordpress)/i,
  /^\/(admin|administrator|phpmyadmin|phpMyAdmin|pma)/i,
  /^\/(favicon\.ico|robots\.txt|sitemap\.xml|ads\.txt|\.well-known)/i,
  /^\/(webui|geoserver|developmentserver|solr|actuator|console)/i,
  /^\/(cgi-bin|scripts|shell|eval|setup|install|config)/i,
  /^\/(login|signin|dashboard|panel|manager|jmx-console)/i,
  /^\/[a-zA-Z]*\.(php|asp|aspx|jsp|cgi)$/i,
];

/**
 * Catch-all middleware for unmatched routes.
 * Silently rejects known bot/scanner probes with a 404.
 * Only logs genuinely unexpected routes via ApiError.
 */
export const unmatchedRouteHandler = (req, res, next) => {
  // Silently reject known bot/scanner probes
  const isIgnored = IGNORED_ROUTE_PATTERNS.some((pattern) =>
    pattern.test(req.originalUrl)
  );
  if (isIgnored) {
    return res.status(404).json({ status: "fail", message: "Not found" });
  }

  // Also silently reject non-API POST/PUT/DELETE to root "/"
  if (req.originalUrl === "/" && req.method !== "GET") {
    return res.status(404).json({ status: "fail", message: "Not found" });
  }

  // Only log genuinely unexpected routes
  next(new ApiError(`can't find this route: ${req.originalUrl}`, 400));
};
