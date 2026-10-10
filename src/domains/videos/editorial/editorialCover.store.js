import sharp from "sharp";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { IMAGE_UPLOAD_PROFILES, uploadImage } from "../../../shared/utils/imageUpload.js";
import { deleteBunnyObject } from "../../../shared/utils/bunnyStorage.js";
import { getMediaConfiguration } from "../../../shared/utils/mediaConfig.js";

function coverId(value) {
  const id = String(value);
  if (!/^[a-f\d]{24}$/i.test(id)) throw new TypeError("Invalid editorial cover ID");
  return id.toLowerCase();
}

function invalidImage() {
  return new ApiError("Cover must be a portrait JPEG, PNG or WebP image of at most 5 MB",
    422, [{ code: "VIDEO_INVALID_COVER" }]);
}

async function validateCoverBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 5 * 1024 * 1024) throw invalidImage();
  try {
    const image = sharp(buffer, { limitInputPixels: 16_000_000 });
    const metadata = await image.metadata();
    const { width, height } = metadata.autoOrient;
    if (!["jpeg", "png", "webp"].includes(metadata.format) ||
        (metadata.pages || 1) !== 1 || !width || !height || height <= width) throw invalidImage();
    // Header inspection alone can accept truncated/corrupt image bodies.
    await image.stats();
    return metadata;
  } catch { throw invalidImage(); }
}

// The caller must persist a fresh cover generation before PUT. Its deterministic
// key allows cleanup after a lost response, without trusting a client URL.
// This storage seam does not authorize attachment or perform best-effort cleanup.
export function createEditorialCoverStore({ configuration = getMediaConfiguration,
  upload = uploadImage, remove = deleteBunnyObject } = {}) {
  function config(expected) {
    const value = configuration();
    if (value.publicProvider !== "bunny" || !value.public) {
      throw new ApiError("Bunny public image storage is required for covers", 503,
        [{ code: "VIDEO_COVER_STORAGE_UNAVAILABLE" }]);
    }
    if (expected && ["zone", "endpoint", "cdnBaseUrl"].some((key) => expected[key] !== value.public[key])) {
      throw new ApiError("Cover storage configuration changed", 503,
        [{ code: "VIDEO_COVER_STORAGE_CHANGED" }]);
    }
    return value;
  }

  return Object.freeze({
    validate: ({ buffer }) => validateCoverBuffer(buffer),
    identity() {
      const { zone, endpoint, cdnBaseUrl } = config().public;
      return { zone, endpoint, cdnBaseUrl };
    },
    async upload({ coverId: generation, buffer, storage }) {
      const id = coverId(generation);
      const value = config(storage);
      const metadata = await validateCoverBuffer(buffer);
      return upload({ buffer, size: buffer.length,
        mimetype: metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}` },
      { folder: "petyard/video-covers", publicId: id,
        profile: IMAGE_UPLOAD_PROFILES.PORTRAIT, configuration: value });
    },
    async remove({ coverId: generation, storage }) {
      const id = coverId(generation);
      const value = config(storage);
      // Unlike deleteImage, this propagates rejection so durable work can retry.
      await remove({ ...value.public, objectKey: `petyard/video-covers/${id}.webp`,
        timeoutMs: value.storageTimeoutMs });
    },
  });
}
