import { json } from "express";
import { PRODUCT_BATCH_MAX_REQUEST_BYTES } from "./productBatch.constants.js";
import { ApiError } from "../../shared/utils/ApiError.js";

// Mount before the application-wide parser to bound raw JSON, including chunked bodies.
const parse = json({ limit: PRODUCT_BATCH_MAX_REQUEST_BYTES });
export function productBatchBodyParser(req, res, next) {
  if (req.method !== "POST") return next();
  if (!req.is("application/json")) return next(new ApiError("Product batch requires application/json.", 415));
  parse(req, res, (error) => {
    if (!error) return next();
    if (error.type === "entity.too.large") return next(new ApiError("Product batch request exceeds 2 KiB.", 413));
    if (["entity.parse.failed", "request.aborted", "request.size.invalid"].includes(error.type)) {
      return next(new ApiError("Invalid product batch JSON body.", 400));
    }
    if (["charset.unsupported", "encoding.unsupported"].includes(error.type)) {
      return next(new ApiError("Unsupported product batch body encoding.", 415));
    }
    next(error);
  });
}
