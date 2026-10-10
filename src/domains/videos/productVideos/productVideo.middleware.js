import { ApiError } from "../../../shared/utils/ApiError.js";
import { getVideosStreamConfiguration } from "../provider/streamConfig.js";

export function createProductVideoUploadGuard({
  isUploadEnabled = () => getVideosStreamConfiguration().flags.productVideoUploadsEnabled,
} = {}) {
  return (_req, _res, next) => {
    if (!isUploadEnabled()) return next(new ApiError("Product Video uploads are disabled", 503,
      [{ code: "VIDEO_UPLOAD_DISABLED" }]));
    next();
  };
}
