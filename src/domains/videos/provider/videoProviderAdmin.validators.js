import { videoProviderOperationTypeEnum, videoProviderOperationStatusEnum } from "../../../shared/constants/enums.js";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { pagination } from "../video.validators.js";

const TYPES = Object.values(videoProviderOperationTypeEnum);
const STATUSES = Object.values(videoProviderOperationStatusEnum);
const invalid = () => new ApiError("Invalid provider operation input", 422,
  [{ code: "VIDEO_OPERATION_INVALID_INPUT" }]);

export function validateOperationQuery(query = {}) {
  if (!query || typeof query !== "object" || Array.isArray(query) ||
      Object.keys(query).some(key => !["page", "limit", "status", "type"].includes(key)) ||
      [query.page, query.limit].some(value => value !== undefined &&
        !["string", "number"].includes(typeof value)) ||
      (query.status !== undefined && !STATUSES.includes(query.status)) ||
      (query.type !== undefined && !TYPES.includes(query.type))) throw invalid();
  return { ...pagination(query.page, query.limit),
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.type !== undefined ? { type: query.type } : {}) };
}

export function validateOperationRetry(operationId, input = {}) {
  if (typeof operationId !== "string" || !/^[a-f\d]{24}$/i.test(operationId) ||
      !input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw invalid();
  return operationId.toLowerCase();
}

export function operationListValidator(req, _res, next) {
  validateOperationQuery(req.query);
  next();
}

export function operationRetryValidator(req, _res, next) {
  validateOperationRetry(req.params.operationId, req.body);
  next();
}
