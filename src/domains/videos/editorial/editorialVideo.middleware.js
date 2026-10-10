import multer from "multer";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { getVideosStreamConfiguration } from "../provider/streamConfig.js";

export const uploadEditorialCover = multer({ storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 2 } }).single("cover");

export function createEditorialVideoGuards({
  isReelUploadEnabled = () => getVideosStreamConfiguration().flags.reelUploadsEnabled,
  // Release switches attest that persistence, workers and providers were verified.
  isReelPipelineReady = () => getVideosStreamConfiguration().flags.reelPipelineReady,
  isCoverPipelineReady = () => getVideosStreamConfiguration().flags.coverPipelineReady,
} = {}) {
  return Object.freeze({
    requireReelUploads(_req, _res, next) {
      if (!isReelUploadEnabled() || !isReelPipelineReady()) {
        return next(new ApiError("Reel uploads are unavailable", 503, [{ code: "VIDEO_UPLOAD_DISABLED" }]));
      }
      next();
    },
    requireCoverUploads(_req, _res, next) {
      if (!isCoverPipelineReady()) {
        return next(new ApiError("Cover uploads are unavailable", 503, [{ code: "VIDEO_COVER_DISABLED" }]));
      }
      next();
    },
  });
}
