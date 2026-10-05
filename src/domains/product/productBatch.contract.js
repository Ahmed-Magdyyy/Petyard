import { ApiError } from "../../shared/utils/ApiError.js";
import { PRODUCT_BATCH_MAX_IDS, PRODUCT_BATCH_MAX_REQUEST_BYTES } from "./productBatch.constants.js";

export function parseProductBatchBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "ids") || !Array.isArray(body.ids) ||
    body.ids.length > PRODUCT_BATCH_MAX_IDS ||
    body.ids.some((id) => typeof id !== "string" || !/^[0-9a-f]{24}$/i.test(id))) {
    throw new ApiError(`Supply ids as an array of at most ${PRODUCT_BATCH_MAX_IDS} MongoDB product IDs.`, 400);
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > PRODUCT_BATCH_MAX_REQUEST_BYTES) {
    throw new ApiError("Product batch request is too large.", 413);
  }
  return [...new Set(body.ids.map((id) => id.toLowerCase()))];
}
