import { createProductVideoProductDeletionRepository } from "./productVideoProductDeletion.repository.js";
import { getVideosStreamConfiguration } from "../provider/streamConfig.js";
import { enqueueVideoProviderOperation, enqueueVideoProviderOperations } from "../provider/videoProvider.queue.js";

// Called by the Product domain after its existing image cleanup. The repository
// commits Product deletion, placement tombstones and cleanup obligations together.
export async function deleteProductWithVideoCleanup({
  enqueue = enqueueVideoProviderOperation,
  isUploadEnabled = () => getVideosStreamConfiguration().flags.productVideoUploadsEnabled,
  ...persistence
}) {
  const repository = createProductVideoProductDeletionRepository(persistence);
  if (!isUploadEnabled() && !await repository.hasPlacements()) {
    await repository.deleteImageOnly();
    return;
  }
  const operationIds = await repository.deleteWithVideos();
  await enqueueVideoProviderOperations(operationIds, enqueue);
}
