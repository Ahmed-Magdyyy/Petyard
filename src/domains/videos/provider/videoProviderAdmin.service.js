import { ApiError } from "../../../shared/utils/ApiError.js";
import { roles } from "../../../shared/constants/enums.js";
import { createVideoProviderOperationRepository } from "./videoProviderOperation.repository.js";
import { validateOperationQuery, validateOperationRetry } from "./videoProviderAdmin.validators.js";
import { enqueueVideoProviderOperation } from "./videoProvider.queue.js";

const unavailable = () => new ApiError("Provider operation administration is unavailable", 503,
  [{ code: "VIDEO_OPERATION_UNAVAILABLE" }]);
function requireSuperAdmin(actor) {
  if (!actor?.id || actor.role !== roles.SUPER_ADMIN) {
    throw new ApiError("Not allowed to administer provider operations", 403, [{ code: "VIDEO_FORBIDDEN" }]);
  }
}
function describe(operation) {
  const data = { id: String(operation._id), type: operation.type, status: operation.status,
    failedAttempts: operation.failedAttempts };
  for (const field of ["createdAt", "updatedAt", "nextAttemptAt", "leaseExpiresAt", "completedAt",
    "lastErrorAt", "lastEnqueueErrorAt"]) data[field] = operation[field] ?? null;
  for (const field of ["lastErrorCode", "lastEnqueueErrorCode"]) {
    data[field] = operation[field] == null ? null :
      /^[A-Z][A-Z0-9_]{0,63}$/.test(operation[field]) ? operation[field] : "PROVIDER_ERROR";
  }
  return data;
}

let productionService;
export async function getVideoProviderAdminService() {
  productionService ??= createVideoProviderAdminService();
  return productionService;
}

export function createVideoProviderAdminService({ repository = createVideoProviderOperationRepository(),
  enqueue = enqueueVideoProviderOperation, now = () => new Date() } = {}) {
  return Object.freeze({
    async list({ actor, query }) {
      requireSuperAdmin(actor);
      const filter = validateOperationQuery(query);
      let result;
      try { result = await repository.listAdmin(filter); } catch { throw unavailable(); }
      return { totalResults: result.totalResults, totalPages: Math.ceil(result.totalResults / filter.limit) || 1,
        page: filter.page, results: result.data.length, data: result.data.map(describe) };
    },
    async retry({ actor, operationId, input }) {
      requireSuperAdmin(actor);
      const id = validateOperationRetry(operationId, input);
      const timestamp = now();
      let operation;
      let exists;
      try {
        // Reuse the needs-attention-only compare-and-set used by the existing
        // immediate retry service. No provider call or worker lease is bypassed.
        operation = await repository.retry(id, timestamp);
        if (!operation) exists = await repository.findById(id);
      } catch { throw unavailable(); }
      if (!operation) throw new ApiError(exists ? "Operation cannot be retried in this state" : "Operation not found",
        exists ? 409 : 404, [{ code: exists ? "VIDEO_OPERATION_STATE_CONFLICT" : "VIDEO_OPERATION_NOT_FOUND" }]);
      let queued = false;
      try { await enqueue(id); queued = true; }
      catch {
        // The operation is already due. Even failure to record this queue error
        // must not roll it back or discard its sweeper recovery obligation.
        try { await repository.recordEnqueueFailure(id, timestamp, "QUEUE_ERROR"); } catch { /* Durable work remains due. */ }
      }
      return { operation: describe(operation), queued };
    },
  });
}
