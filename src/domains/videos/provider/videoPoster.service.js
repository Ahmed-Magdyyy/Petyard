import { videoAssetTechnicalStateEnum } from "../../../shared/constants/enums.js";
import { createVideoPosterRepository } from "./videoPoster.repository.js";

function eligible(asset) {
  return asset?.technicalState === videoAssetTechnicalStateEnum.READY && asset.providerStatus === 4 &&
    !asset.deletionRequestedAt && !asset.deleteAcceptedAt;
}

function preservePublishedPoster(asset) {
  // A pending/rejected explicit delete leaves current Product Video media
  // visible until Stream acceptance. Do not remove an attached cover early.
  return asset?.poster?.url && !asset.deleteAcceptedAt && asset.technicalState !== videoAssetTechnicalStateEnum.DELETED;
}

export function createVideoPosterService({ provider, store, model,
  repository = createVideoPosterRepository({ model }), now = Date.now } = {}) {
  if (!provider?.getVideo || !provider?.readThumbnail || !store?.upload || !store?.remove) {
    throw new TypeError("Poster provider and image store are required");
  }
  return Object.freeze({
    async copy({ operation }) {
      const asset = await repository.findForOperation(operation);
      if (!asset) throw new Error("VIDEO_POSTER_ASSET_MISSING");
      if (!eligible(asset)) {
        // Also compensates an uncertain/late PUT, even without a descriptor.
        if (!preservePublishedPoster(asset)) await store.remove({ assetId: operation.assetId });
        return;
      }
      if (asset.poster?.url) return;
      const snapshot = await provider.getVideo(operation.providerGuid);
      if (snapshot?.guid !== operation.providerGuid || snapshot.status !== 4 ||
          String(snapshot.videoLibraryId) !== operation.libraryId) {
        throw new Error("VIDEO_POSTER_PROVIDER_MISMATCH");
      }
      const buffer = await provider.readThumbnail({ videoId: operation.providerGuid,
        fileName: snapshot.thumbnailFileName });
      // A slow download must not start a storage write for a generation whose
      // deletion intent was committed while the bytes were being read.
      const beforeUpload = await repository.findForOperation(operation);
      if (!eligible(beforeUpload)) {
        if (!preservePublishedPoster(beforeUpload)) await store.remove({ assetId: operation.assetId });
        return;
      }
      if (beforeUpload.poster?.url) return;
      const poster = await store.upload({ assetId: operation.assetId, buffer });
      const attached = await repository.attachIfEligible(operation, poster, snapshot.thumbnailFileName, new Date(now()));
      if (attached) return;
      const current = await repository.findForOperation(operation);
      if (preservePublishedPoster(current) && current.poster.url === poster.url) return;
      await store.remove({ assetId: operation.assetId });
    },
    async remove({ operation }) {
      await store.remove({ assetId: operation.assetId });
    },
  });
}
