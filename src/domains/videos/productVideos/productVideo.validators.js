import { ApiError } from "../../../shared/utils/ApiError.js";

const MAX_VIDEO_BYTES = 250 * 1024 * 1024;

export function invalidMedia() {
  return new ApiError("Invalid Product Video upload", 400, [{ code: "VIDEO_INVALID_MEDIA" }]);
}

export function validateOrphanTarget(target) {
  const { videoId, replacementId, recoveryId } = target ?? {};
  if (typeof videoId !== "string" || !/^[a-f\d]{24}$/i.test(videoId) ||
      (replacementId !== undefined && (typeof replacementId !== "string" || !/^[a-f\d]{24}$/i.test(replacementId))) ||
      (recoveryId !== undefined && (typeof recoveryId !== "string" || !/^[a-f\d]{24}$/i.test(recoveryId))) ||
      (recoveryId !== undefined && replacementId !== undefined)) {
    throw invalidMedia();
  }
  return { videoId: videoId.toLowerCase(), replacementId: replacementId?.toLowerCase(),
    ...(recoveryId !== undefined ? { recoveryId: recoveryId.toLowerCase() } : {}) };
}

export function productVideoUploadRecoveryValidator(req, _res, next) {
  if (!req.body || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, "file")) throw invalidMedia();
  validateBatch({ productId: req.params.id, actorId: req.user?._id,
    idempotencyKey: req.get("Idempotency-Key"), files: [req.body.file] });
  if (!/^[a-f\d]{24}$/i.test(String(req.params.videoId)) ||
      (req.params.replacementId !== undefined && !/^[a-f\d]{24}$/i.test(String(req.params.replacementId))) ||
      req.body.file.showInReelsFeed !== undefined) throw invalidMedia();
  next();
}

export function validateBatch({ productId, actorId, idempotencyKey, files }) {
  if (![productId, actorId].every((value) => /^[a-f\d]{24}$/i.test(String(value))) ||
      typeof idempotencyKey !== "string" ||
      idempotencyKey.trim().length < 8 || idempotencyKey.trim().length > 128 ||
      !Array.isArray(files) || files.length < 1 || files.length > 3) {
    throw invalidMedia();
  }
  const seen = new Set();
  for (const file of files) {
    const extension = typeof file?.filename === "string"
      ? file.filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
      : null;
    if (typeof file?.clientId !== "string" || !file.clientId.trim() ||
        file.clientId.length > 100 || seen.has(file.clientId) ||
        typeof file.filename !== "string" || file.filename.length > 160 ||
        /[\\/\x00-\x1F]/.test(file.filename) ||
        !((extension === "mp4" && file.mimeType === "video/mp4") ||
          (extension === "mov" && file.mimeType === "video/quicktime")) ||
        !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 ||
        file.sizeBytes > MAX_VIDEO_BYTES ||
        (file.showInReelsFeed !== undefined &&
          typeof file.showInReelsFeed !== "boolean")) {
      throw invalidMedia();
    }
    seen.add(file.clientId);
  }
}

export function productVideoVisibilityValidator(req, _res, next) {
  if (!req.body || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, "showInReelsFeed")) {
    throw new ApiError("Invalid Product Video visibility", 400, [{ code: "VIDEO_INVALID_VISIBILITY" }]);
  }
  next();
}
