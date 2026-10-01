import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { UiLayoutAssetModel } from "./uiLayout.model.js";
import { UiLayoutError } from "./uiLayout.error.js";
import { isPublicHttpsUrl } from "./uiLayout.contract.js";
import { beforePageFilter, encodePageCursor } from "./uiLayout.pagination.js";
import { assetData } from "./uiLayout.serialization.js";
import { UI_ASSET_MIME, UI_ASSET_MAX_BYTES, UI_ASSET_MAX_PIXELS,
  UI_ASSET_USAGES } from "./uiLayout.constants.js";
import {
  uploadImage, deleteImage, IMAGE_UPLOAD_PROFILES, IMAGE_VISIBILITY,
} from "../../shared/utils/imageUpload.js";

export async function createUiBuilderAsset({ file, usage, actorId, assetModel = UiLayoutAssetModel,
  upload = uploadImage, remove = deleteImage, uuid = randomUUID }) {
  if (!UI_ASSET_USAGES.includes(usage)) {
    throw new UiLayoutError("UI_ASSET_INVALID_USAGE", "usage must be promo or dynamic_item.", 400);
  }
  if (!file || !Buffer.isBuffer(file.buffer) || file.size < 1 || file.size > UI_ASSET_MAX_BYTES) {
    throw new UiLayoutError("UI_ASSET_INVALID_FILE", "An image of at most 5 MB is required.", 400);
  }
  let metadata;
  try {
    metadata = await sharp(file.buffer, { limitInputPixels: UI_ASSET_MAX_PIXELS }).metadata();
  } catch {
    throw new UiLayoutError("UI_ASSET_INVALID_FILE", "Image could not be decoded safely.", 400);
  }
  if (!UI_ASSET_MIME[metadata.format] || file.mimetype !== UI_ASSET_MIME[metadata.format] ||
    !metadata.width || !metadata.height || metadata.width > 8000 || metadata.height > 8000 ||
    metadata.width * metadata.height > UI_ASSET_MAX_PIXELS) {
    throw new UiLayoutError("UI_ASSET_INVALID_FILE", "Only bounded JPEG, PNG, and WebP images are supported.", 400);
  }
  await assetModel.init?.();
  const id = uuid();
  const uploaded = await upload(file, {
    folder: "petyard/ui-builder", publicId: id,
    visibility: IMAGE_VISIBILITY.PUBLIC, profile: IMAGE_UPLOAD_PROFILES.STANDARD,
  });
  try {
    if (typeof uploaded?.public_id !== "string" || !uploaded.public_id ||
      !isPublicHttpsUrl(uploaded.url)) {
      throw new UiLayoutError("UI_ASSET_STORAGE_INVALID", "Image storage returned an invalid public asset.", 502);
    }
    const asset = await assetModel.create({
      id, status: "ready", usage, url: uploaded.url, publicId: uploaded.public_id,
      mimeType: file.mimetype, width: metadata.width, height: metadata.height,
      byteSize: file.size, createdBy: actorId,
    });
    return assetData(asset);
  } catch (error) {
    if (uploaded?.public_id) {
      try { await remove(uploaded); } catch (cleanupError) {
        console.error("[UI Layout Asset] Could not remove orphaned upload", cleanupError?.message);
      }
    }
    throw error;
  }
}

export async function listUiBuilderAssets({ limit = 30, before, assetModel = UiLayoutAssetModel } = {}) {
  const filter = { status: "ready" };
  if (before) filter.$or = beforePageFilter("createdAt", before);
  const assets = await assetModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1);
  const page = assets.slice(0, limit);
  return { items: page.map(assetData),
    next_before: assets.length > limit ? encodePageCursor(page.at(-1), "createdAt") : null };
}
