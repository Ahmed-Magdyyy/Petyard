import sharp from "sharp";
import { uploadImage } from "../../../shared/utils/imageUpload.js";
import { deleteBunnyObject } from "../../../shared/utils/bunnyStorage.js";
import { getMediaConfiguration } from "../../../shared/utils/mediaConfig.js";

function posterId(assetId) {
  const id = String(assetId);
  if (!/^[a-f\d]{24}$/i.test(id)) throw new TypeError("Invalid poster asset ID");
  return id.toLowerCase();
}

// One immutable asset generation owns one key, including when a PUT succeeds
// but its response or the subsequent Mongo write is lost. Cleanup does not
// depend on a successfully persisted image descriptor.
export function createVideoPosterStore({ configuration = getMediaConfiguration,
  upload = uploadImage, remove = deleteBunnyObject } = {}) {
  function config() {
    const value = configuration();
    if (value.publicProvider !== "bunny" || !value.public) {
      throw new Error("VIDEO_POSTER_BUNNY_STORAGE_REQUIRED");
    }
    return value;
  }
  return Object.freeze({
    async upload({ assetId, buffer }) {
      const id = posterId(assetId);
      const value = config();
      if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > 5 * 1024 * 1024) {
        throw new Error("VIDEO_POSTER_INVALID_IMAGE");
      }
      const metadata = await sharp(buffer, { limitInputPixels: 16 * 1024 * 1024 }).metadata();
      if (!["jpeg", "png", "webp"].includes(metadata.format) ||
          (metadata.pages || 1) !== 1 || !metadata.width || !metadata.height) {
        throw new Error("VIDEO_POSTER_INVALID_IMAGE");
      }
      return upload({ buffer, size: buffer.length,
        mimetype: metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}` },
      { folder: "petyard/video-posters", publicId: id, configuration: value });
    },
    async remove({ assetId }) {
      const id = posterId(assetId);
      const value = config();
      // Use the strict storage primitive: the general best-effort deleteImage
      // helper swallows failures and cannot acknowledge durable cleanup.
      await remove({ ...value.public, objectKey: `petyard/video-posters/${id}.webp`,
        timeoutMs: value.storageTimeoutMs });
    },
  });
}
