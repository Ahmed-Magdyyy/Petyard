import { ApiError } from "../../../shared/utils/ApiError.js";

export const MAX_VIDEO_PRODUCT_LINKS = 50;

export function invalidVideoProductLink(field = "productIds") {
  return new ApiError("Video product links must contain up to 50 unique active Product IDs", 422,
    [{ code: "VIDEO_INVALID_PRODUCT_IDS", field }]);
}

export function normalizedVideoProductIds(value = []) {
  if (!Array.isArray(value) || value.length > MAX_VIDEO_PRODUCT_LINKS) throw invalidVideoProductLink();
  const seen = new Set();
  return value.map((id, index) => {
    if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id) || seen.has(id.toLowerCase())) {
      throw invalidVideoProductLink(`productIds[${index}]`);
    }
    const normalized = id.toLowerCase();
    seen.add(normalized);
    return normalized;
  });
}
