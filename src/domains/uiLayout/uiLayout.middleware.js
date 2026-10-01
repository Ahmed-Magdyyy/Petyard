import multer from "multer";
import { UiLayoutError } from "./uiLayout.error.js";
import { UI_ASSET_MAX_BYTES } from "./uiLayout.constants.js";

const parseAssetUpload = multer({ storage: multer.memoryStorage(),
  limits: { fileSize: UI_ASSET_MAX_BYTES, files: 1, fields: 2, fieldSize: 100 },
}).single("image");

export function uploadUiBuilderImage(req, res, next) {
  parseAssetUpload(req, res, (error) => {
    if (!error) return next();
    return next(new UiLayoutError("UI_ASSET_INVALID_UPLOAD", "Invalid image upload.", 400));
  });
}

export function requireUiLayoutReleaseEnabled(_req, _res, next) {
  if (process.env.UI_BUILDER_PUBLISH_ENABLED !== "true") {
    throw new UiLayoutError("UI_LAYOUT_RELEASE_DISABLED", "UI Builder publication is not enabled.", 503);
  }
  next();
}

export function uiLayoutErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (!req.originalUrl.startsWith("/api/v1/admin/home-layouts") &&
    !req.originalUrl.startsWith("/api/v1/admin/ui-builder") &&
    !req.originalUrl.startsWith("/api/v1/ui-layouts") &&
    !req.originalUrl.startsWith("/api/v1/home-layout/preview") &&
    !(req.method === "GET" && process.env.UI_BUILDER_PUBLIC_CUTOVER_ENABLED === "true" &&
      req.originalUrl.startsWith("/api/v1/home-layout"))) return next(error);
  if (!error.isOperational) return next(error);
  res.setHeader("Cache-Control", "no-store");
  return res.status(error.statusCode || 500).json({
    error: {
      code: error.code || (error.statusCode === 401 ? "UNAUTHORIZED" :
        error.statusCode === 403 ? "FORBIDDEN" : "UI_LAYOUT_REQUEST_FAILED"),
      message: error.message,
      request_id: req.requestId,
      details: error.details ?? error.errors ?? [],
    },
  });
}
