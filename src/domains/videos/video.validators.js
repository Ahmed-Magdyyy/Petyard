import { ApiError } from "../../shared/utils/ApiError.js";

function videoError(message, statusCode, code) {
  return new ApiError(message, statusCode, [{ code }]);
}

export function pagination(page = 1, limit = 20) {
  const p = Number(page);
  const l = Number(limit);
  if (!Number.isSafeInteger(p) || p < 1 || !Number.isSafeInteger(l) || l < 1 || l > 100) {
    throw videoError("Invalid pagination", 422, "VIDEO_INVALID_PAGINATION");
  }
  return { page: p, limit: l };
}
