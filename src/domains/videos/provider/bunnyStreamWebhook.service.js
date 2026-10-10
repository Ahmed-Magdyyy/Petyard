import { videoProviderOperationStatusEnum } from "../../../shared/constants/enums.js";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { getVideosStreamConfiguration } from "./streamConfig.js";
import { enqueueVideoProviderOperation } from "./videoProvider.queue.js";
import { validateBunnyStreamWebhook } from "./bunnyStreamWebhook.validators.js";

const unavailable = () => new ApiError("Bunny webhook processing is unavailable", 503,
  [{ code: "VIDEO_WEBHOOK_UNAVAILABLE" }]);
let productionService;

export async function getBunnyStreamWebhookService() {
  if (!productionService) {
    const stream = getVideosStreamConfiguration().stream;
    if (!stream) throw unavailable();
    const { createBunnyStreamWebhookRepository } = await import("./bunnyStreamWebhook.repository.js");
    productionService = createBunnyStreamWebhookService({ libraryId: stream.libraryId,
      signingKey: stream.readOnlyApiKey, repository: createBunnyStreamWebhookRepository() });
  }
  return productionService;
}

export function createBunnyStreamWebhookService({ libraryId, signingKey, repository,
  enqueue = enqueueVideoProviderOperation }) {
  if (typeof libraryId !== "string" || !/^\d+$/.test(libraryId) ||
      typeof signingKey !== "string" || !signingKey.trim() ||
      typeof repository?.recordHint !== "function" || typeof enqueue !== "function") {
    throw new TypeError("Bunny webhook configuration and repository are required");
  }
  return Object.freeze({
    async receive({ rawBody, headers }) {
      const hint = validateBunnyStreamWebhook({ rawBody, headers, libraryId, signingKey });
      let operation;
      try { operation = await repository.recordHint(hint); } catch { throw unavailable(); }
      if (!operation) return { status: "ignored" };
      const operationId = String(operation._id);
      let queued = false;
      if ([videoProviderOperationStatusEnum.PENDING, videoProviderOperationStatusEnum.NEEDS_ATTENTION].includes(operation.status)) {
        // Persist first. Redis failure does not acknowledge away the obligation:
        // the existing operation sweeper will rediscover it.
        try { await enqueue(operationId); queued = true; } catch { /* Durable work remains due. */ }
      }
      return { status: "recorded", operationId, queued };
    },
  });
}
