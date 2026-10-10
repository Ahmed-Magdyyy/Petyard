import { editorialVideoKindEnum, editorialVideoStatusEnum } from "../../../shared/constants/enums.js";
import { ApiError } from "../../../shared/utils/ApiError.js";

function videoError(message, statusCode, code) {
  return new ApiError(message, statusCode, [{ code }]);
}

function youtubeIdFromUrl(value) {
  if (typeof value !== "string") throw videoError("Invalid YouTube URL", 422, "VIDEO_INVALID_YOUTUBE_URL");
  let url;
  try { url = new URL(value); } catch { throw videoError("Invalid YouTube URL", 422, "VIDEO_INVALID_YOUTUBE_URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      url.searchParams.has("list")) {
    throw videoError("Invalid YouTube URL", 422, "VIDEO_INVALID_YOUTUBE_URL");
  }
  const host = url.hostname.toLowerCase();
  let id;
  if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
    if (url.pathname === "/watch") {
      const values = url.searchParams.getAll("v");
      if (values.length === 1) id = values[0];
    } else {
      const match = /^\/shorts\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
      id = match?.[1];
    }
  } else if (["youtu.be", "www.youtu.be"].includes(host)) {
    const match = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
    id = match?.[1];
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id || "")) {
    throw videoError("Invalid YouTube URL", 422, "VIDEO_INVALID_YOUTUBE_URL");
  }
  return id;
}

export function normalizedText(value, field, { required = false, maxLength = 160 } = {}) {
  if (value == null && !required) return "";
  if (typeof value !== "string" || (required && !value.trim()) || value.trim().length > maxLength) {
    throw videoError(`Invalid ${field}`, 422, "VIDEO_INVALID_METADATA");
  }
  return value.trim();
}

export function normalizedYouTubeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw videoError("Invalid Video", 422, "VIDEO_INVALID_METADATA");
  }
  const allowed = new Set(["kind", "youtubeUrl", "title_en", "title_ar",
    "description_en", "description_ar"]);
  if (Object.keys(input).some((key) => !allowed.has(key)) ||
      (input.kind !== undefined && input.kind !== editorialVideoKindEnum.YOUTUBE)) {
    throw videoError("Invalid Video", 422, "VIDEO_INVALID_METADATA");
  }
  return {
    youtubeId: youtubeIdFromUrl(input.youtubeUrl),
    title_en: normalizedText(input.title_en, "title_en", { required: true }),
    title_ar: normalizedText(input.title_ar, "title_ar", { required: true }),
    description_en: normalizedText(input.description_en, "description_en", { maxLength: 2000 }),
    description_ar: normalizedText(input.description_ar, "description_ar", { maxLength: 2000 }),
  };
}

export function normalizedReelInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw videoError("Invalid Reel", 422, "VIDEO_INVALID_METADATA");
  }
  const allowed = new Set(["kind", "title_en", "title_ar", "description_en", "description_ar"]);
  if (input.kind !== editorialVideoKindEnum.REEL || Object.keys(input).some((key) => !allowed.has(key))) {
    throw videoError("Invalid Reel", 422, "VIDEO_INVALID_METADATA");
  }
  return {
    title_en: normalizedText(input.title_en, "title_en", { required: true }),
    title_ar: normalizedText(input.title_ar, "title_ar", { required: true }),
    description_en: normalizedText(input.description_en, "description_en", { maxLength: 2000 }),
    description_ar: normalizedText(input.description_ar, "description_ar", { maxLength: 2000 }),
  };
}

export function editedContent(kind, base, input) {
  const allowed = new Set(["title_en", "title_ar", "description_en", "description_ar",
    ...(kind === editorialVideoKindEnum.YOUTUBE ? ["youtubeUrl"] : [])]);
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !Object.keys(input).length || Object.keys(input).some((key) => !allowed.has(key))) {
    throw videoError("Invalid Video edit", 422, "VIDEO_INVALID_METADATA");
  }
  if (kind === editorialVideoKindEnum.REEL) return normalizedReelInput({ kind,
    title_en: base.title_en, title_ar: base.title_ar,
    description_en: base.description_en, description_ar: base.description_ar, ...input });
  return normalizedYouTubeInput({
    youtubeUrl: input.youtubeUrl ?? `https://youtu.be/${base.youtubeId}`,
    title_en: input.title_en ?? base.title_en,
    title_ar: input.title_ar ?? base.title_ar,
    description_en: input.description_en ?? base.description_en,
    description_ar: input.description_ar ?? base.description_ar,
  });
}

export function coverUploadValidator(req, _res, next) {
  if (!req.file || Object.keys(req.body ?? {}).length) throw videoError("A cover file is required", 422, "VIDEO_INVALID_COVER");
  next();
}

export function coverRemovalValidator(req, _res, next) {
  if (Object.keys(req.body ?? {}).length) throw videoError("Cover removal does not accept fields", 422, "VIDEO_INVALID_COVER");
  next();
}

export function validatePublicPosition(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== 1 || !Object.hasOwn(input, "position") ||
      (input.position !== null && (!Number.isSafeInteger(input.position) || input.position < 0))) {
    throw videoError("Invalid Video position", 422, "VIDEO_INVALID_POSITION");
  }
}

export function validatePublicPositions(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== 2 || !Object.values(editorialVideoKindEnum).includes(input.kind) ||
      !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) {
    throw videoError("Invalid Video positions", 422, "VIDEO_INVALID_POSITION");
  }
  const ids = new Set();
  const items = input.items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).length !== 3 || Object.keys(item).some((key) => !["videoId", "revision", "position"].includes(key)) ||
        typeof item.videoId !== "string" || !/^[a-f\d]{24}$/i.test(item.videoId) ||
        !Number.isSafeInteger(item.revision) || item.revision < 0 || item.revision >= Number.MAX_SAFE_INTEGER) {
      throw videoError("Invalid Video positions", 422, "VIDEO_INVALID_POSITION");
    }
    validatePublicPosition({ position: item.position });
    const videoId = item.videoId.toLowerCase();
    if (ids.has(videoId)) throw videoError("Duplicate Video position target", 422, "VIDEO_INVALID_POSITION");
    ids.add(videoId);
    return { videoId, revision: item.revision, position: item.position };
  });
  return { kind: input.kind, items };
}

export function publicPositionsValidator(req, _res, next) {
  validatePublicPositions(req.body);
  next();
}

export function validateDraftPosition(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== 2 || !Object.hasOwn(input, "draftPosition") || !Object.hasOwn(input, "revision") ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision >= Number.MAX_SAFE_INTEGER) {
    throw videoError("Invalid draft position", 422, "VIDEO_INVALID_POSITION");
  }
  validatePublicPosition({ position: input.draftPosition });
}

export function draftPositionValidator(req, _res, next) {
  validateDraftPosition(req.body);
  next();
}

export function adminDraftFilter(kind, status) {
  if (kind === undefined && status === undefined) return {};
  if (status !== editorialVideoStatusEnum.DRAFT || !Object.values(editorialVideoKindEnum).includes(kind)) {
    throw videoError("Select one draft section", 422, "VIDEO_INVALID_FILTER");
  }
  return { kind, status };
}

export function validatePermanentDeletion(id, input) {
  if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id) ||
      !input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== 1 || !Object.hasOwn(input, "revision") ||
      !Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw videoError("Invalid permanent deletion", 422, "VIDEO_INVALID_DELETE");
  }
}

export function permanentDeletionValidator(req, _res, next) {
  validatePermanentDeletion(req.params.id, req.body);
  next();
}
