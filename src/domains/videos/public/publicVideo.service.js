import { videoContentKindEnum, videoIdentityTypeEnum, videoAnalyticsEventTypeEnum } from "../../../shared/constants/enums.js";
import { randomUUID } from "node:crypto";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { pagination } from "../video.validators.js";
import { pickLocalizedField } from "../../../shared/utils/i18n.js";
import { validatePlayerError } from "./publicVideo.validators.js";

function videoError(message, statusCode, code) {
  return new ApiError(message, statusCode, [{ code }]);
}

let productionService;

export async function getPublicVideoService() {
  if (!productionService) {
    const { createPublicVideoRepository } = await import("./publicVideo.repository.js");
    productionService = createPublicVideoService({
      repository: createPublicVideoRepository(),
      isEnabled: () => String(process.env.VIDEOS_PUBLIC_ENABLED).trim().toLowerCase() === "true",
      isProductEnabled: () => String(process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED).trim().toLowerCase() === "true",
    });
  }
  return productionService;
}


function pageResponse({ totalResults, data }, { page, limit }) {
  return { totalResults, totalPages: Math.ceil(totalResults / limit) || 1,
    page, results: data.length, data };
}

function publicVideo(video, lang, isSaved) {
  if (video.kind === videoContentKindEnum.PRODUCT) {
    const productId = String(video.productId);
    return {
      id: video.id,
      kind: videoContentKindEnum.PRODUCT,
      title: pickLocalizedField(video.product, "name", lang),
      description: null,
      coverUrl: video.asset.poster?.url || null,
      productId,
      productHref: `/api/v1/products/${productId}`,
      playbackHref: `/api/v1/product-videos/${video.id}/playback`,
      canSave: false,
      isSaved: false,
      durationSeconds: video.asset.durationSeconds,
      width: video.asset.width,
      height: video.asset.height,
      aspectRatio: video.asset.width / video.asset.height,
      attachedAt: video.feedAt,
    };
  }
  const common = {
    id: video.id,
    kind: video.kind,
    title: pickLocalizedField(video, "title", lang),
    description: pickLocalizedField(video, "description", lang) || null,
    canSave: true,
    isSaved,
    publishedAt: video.publishedAt,
  };
  if (video.kind === videoContentKindEnum.REEL) {
    return { ...common,
      coverUrl: video.cover?.url || video.asset.poster?.url || null,
      playbackHref: `/api/v1/videos/${video.id}/playback`,
      durationSeconds: video.asset.durationSeconds,
      width: video.asset.width,
      height: video.asset.height,
      aspectRatio: video.asset.width / video.asset.height,
    };
  }
  return { ...common,
    coverUrl: video.cover?.url || `https://i.ytimg.com/vi/${video.youtubeId}/hqdefault.jpg`,
    youtubeId: video.youtubeId,
    embedUrl: `https://www.youtube.com/embed/${video.youtubeId}`,
  };
}

function requireIdentity(identity) {
  if (!identity || !Object.values(videoIdentityTypeEnum).includes(identity.type) ||
      typeof identity.id !== "string" || !identity.id.trim()) {
    throw videoError("Authentication or x-guest-id is required", 401, "VIDEO_IDENTITY_REQUIRED");
  }
}

export function createPublicVideoService({ repository, isEnabled = () => false,
  isProductEnabled = () => false, now = Date.now }) {
  if (!repository?.listYouTube || !repository?.listReels || !repository?.listProducts ||
      !repository?.listMixed || !repository?.getPublished || !repository?.savedIds ||
      !repository?.listSaved || !repository?.save || !repository?.unsave ||
      typeof isEnabled !== "function" || typeof isProductEnabled !== "function" || typeof now !== "function") {
    throw new TypeError("Public Videos require a complete repository");
  }
  function saveTransition(type, contentId) {
    const time = now();
    return { eventId: randomUUID(), type, contentId, counted: true,
      occurredAt: new Date(time), receivedAt: new Date(time),
      expiresAt: new Date(time + 30 * 24 * 60 * 60 * 1000) };
  }
  return Object.freeze({
    async reportPlayerError({ id, identity, body }) {
      requireIdentity(identity);
      const report = validatePlayerError(id, body);
      if (!isEnabled()) throw videoError("Video not found", 404, "VIDEO_NOT_AVAILABLE");
      let accepted;
      try {
        accepted = await repository.recordPlayerErrorAlerts({ ...report,
          day: new Date(now()).toISOString().slice(0, 10),
          notification: {
            title_en: "YouTube playback needs review",
            title_ar: "تشغيل فيديو يوتيوب يحتاج إلى مراجعة",
            body_en: `A player reported ${report.reason} for Video ${report.id}. This is unverified; review before unpublishing.`,
            body_ar: `تم الإبلاغ عن مشكلة تشغيل للفيديو ${report.id}. البلاغ غير مؤكد؛ يرجى المراجعة قبل إلغاء النشر.`,
            icon: "system",
          } });
      } catch {
        throw videoError("Player error report could not be recorded", 503, "VIDEO_REPORT_UNAVAILABLE");
      }
      if (!accepted) throw videoError("Video not found", 404, "VIDEO_NOT_AVAILABLE");
      return { reported: true };
    },
    async listYouTube({ page, limit, lang = "en", identity = null }) {
      const paging = pagination(page, limit);
      if (!isEnabled()) return pageResponse({ totalResults: 0, data: [] }, paging);
      const result = await repository.listYouTube(paging);
      const saved = await repository.savedIds({ identity, videoIds: result.data.map((v) => v.id) });
      return pageResponse({ totalResults: result.totalResults,
        data: result.data.map((v) => publicVideo(v, lang, saved.has(v.id))) }, paging);
    },
    async listFeed({ page, limit, lang = "en", identity = null, kind = videoContentKindEnum.REEL }) {
      const paging = pagination(page, limit);
      if (![videoContentKindEnum.REEL, videoContentKindEnum.PRODUCT, "all"].includes(kind)) {
        throw videoError("Invalid feed kind", 422, "VIDEO_INVALID_KIND");
      }
      const includeReels = isEnabled() && kind !== videoContentKindEnum.PRODUCT;
      const includeProducts = isProductEnabled() && kind !== videoContentKindEnum.REEL;
      if (!includeReels && !includeProducts) {
        return pageResponse({ totalResults: 0, data: [] }, paging);
      }
      const result = kind === videoContentKindEnum.REEL
        ? await repository.listReels(paging)
        : kind === videoContentKindEnum.PRODUCT
          ? await repository.listProducts(paging)
          : await repository.listMixed({ ...paging, includeReels, includeProducts });
      const saved = await repository.savedIds({ identity,
        videoIds: result.data.filter((v) => v.kind === videoContentKindEnum.REEL).map((v) => v.id) });
      return pageResponse({ totalResults: result.totalResults,
        data: result.data.map((v) => publicVideo(v, lang, saved.has(v.id))) }, paging);
    },
    async getVideo({ id, lang = "en", identity = null }) {
      if (!isEnabled()) throw videoError("Video not found", 404, "VIDEO_NOT_AVAILABLE");
      const video = await repository.getPublished(id);
      if (!video) throw videoError("Video not found", 404, "VIDEO_NOT_AVAILABLE");
      const saved = await repository.savedIds({ identity, videoIds: [video.id] });
      return publicVideo(video, lang, saved.has(video.id));
    },
    async listSaved({ identity, page, limit, lang = "en", kind = "all" }) {
      requireIdentity(identity);
      const paging = pagination(page, limit);
      if (!["all", videoContentKindEnum.YOUTUBE, videoContentKindEnum.REEL].includes(kind)) {
        throw videoError("Invalid Video kind", 422, "VIDEO_INVALID_KIND");
      }
      if (!isEnabled()) return pageResponse({ totalResults: 0, data: [] }, paging);
      const result = await repository.listSaved({ identity, kind, ...paging });
      return pageResponse({ totalResults: result.totalResults,
        data: result.data.map((video) => publicVideo(video, lang, true)) }, paging);
    },
    async save({ id, identity }) {
      requireIdentity(identity);
      if (!isEnabled() || !await repository.getPublished(id)) {
        throw videoError("Video not found", 404, "VIDEO_NOT_AVAILABLE");
      }
      let saved;
      try {
        saved = await repository.save({ identity, videoId: id, event: saveTransition(videoAnalyticsEventTypeEnum.SAVE_ADDED, id) });
      } catch {
        throw videoError("Video save could not be recorded", 503, "VIDEO_SAVE_UNAVAILABLE");
      }
      if (saved === false) {
        throw videoError("Video not found", 404, "VIDEO_NOT_AVAILABLE");
      }
      return { videoId: id, isSaved: true };
    },
    async unsave({ id, identity }) {
      requireIdentity(identity);
      if (!isEnabled()) throw videoError("Video not found", 404, "VIDEO_NOT_AVAILABLE");
      try {
        await repository.unsave({ identity, videoId: id, event: saveTransition(videoAnalyticsEventTypeEnum.SAVE_REMOVED, id) });
      } catch {
        throw videoError("Video save could not be removed", 503, "VIDEO_SAVE_UNAVAILABLE");
      }
      return { videoId: id, isSaved: false };
    },
  });
}
