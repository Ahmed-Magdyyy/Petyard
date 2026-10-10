import { ApiError } from "../../../shared/utils/ApiError.js";
import { roles, reelUploadPurposeEnum } from "../../../shared/constants/enums.js";

const MAX_BYTES = 250 * 1024 * 1024;
export function reelResourceRecoveryValidator(req, _res, next) {
  if (!req.body || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, "file")) {
    throw uploadError("Invalid Reel recovery", 400, "VIDEO_INVALID_MEDIA");
  }
  const actor = { id: req.user?._id, role: req.user?.role };
  validateSessionAccess({ videoId: req.params.id, sessionId: req.params.sessionId, actor });
  validateInput({ videoId: req.params.id, actor, file: req.body.file, idempotencyKey: req.get("Idempotency-Key") });
  next();
}
function uploadError(message, statusCode, code) {
  return new ApiError(message, statusCode, [{ code }]);
}

export function validateSessionAccess({ videoId, sessionId, actor, purpose = reelUploadPurposeEnum.INITIAL }) {
  if (![roles.ADMIN, roles.SUPER_ADMIN].includes(actor?.role)) {
    throw uploadError("Not allowed to manage Reel uploads", 403, "VIDEO_FORBIDDEN");
  }
  if (!Object.values(reelUploadPurposeEnum).includes(purpose) || ![videoId, actor?.id, ...(sessionId === undefined ? [] : [sessionId])]
    .every((id) => /^[a-f\d]{24}$/i.test(String(id)))) {
    throw uploadError("Invalid Reel upload identity", 400, "VIDEO_INVALID_MEDIA");
  }
}

export function validateInput({ videoId, actor, idempotencyKey, file }) {
  if (!/^[a-f\d]{24}$/i.test(String(videoId)) ||
      ![roles.ADMIN, roles.SUPER_ADMIN].includes(actor?.role) ||
      !/^[a-f\d]{24}$/i.test(String(actor?.id)) ||
      typeof idempotencyKey !== "string" ||
      idempotencyKey.trim().length < 8 || idempotencyKey.trim().length > 128 ||
      !file || typeof file !== "object" || Array.isArray(file) ||
      Object.keys(file).some((key) => !["filename", "mimeType", "sizeBytes"].includes(key))) {
    throw uploadError("Invalid Reel upload", 400, "VIDEO_INVALID_MEDIA");
  }
  const extension = typeof file.filename === "string"
    ? file.filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] : null;
  if (typeof file.filename !== "string" || !file.filename || file.filename.length > 160 ||
      /[\\/\x00-\x1F]/.test(file.filename) ||
      !((extension === "mp4" && file.mimeType === "video/mp4") ||
        (extension === "mov" && file.mimeType === "video/quicktime")) ||
      !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 || file.sizeBytes > MAX_BYTES) {
    throw uploadError("Invalid Reel upload", 400, "VIDEO_INVALID_MEDIA");
  }
}
