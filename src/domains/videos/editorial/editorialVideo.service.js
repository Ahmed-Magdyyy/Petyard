import { enqueueVideoProviderOperations, enqueueVideoProviderOperation } from "../provider/videoProvider.queue.js";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { normalizedText, normalizedYouTubeInput, normalizedReelInput, editedContent, validatePublicPosition, validatePublicPositions, validateDraftPosition, adminDraftFilter, validatePermanentDeletion } from "./editorialVideo.validators.js";
import { pagination } from "../video.validators.js";
import { getVideosStreamConfiguration } from "../provider/streamConfig.js";
import {
  roles,
  editorialVideoKindEnum,
  editorialVideoStatusEnum,
  editorialReviewStatusEnum,
  videoPreviewSelectionEnum,
} from "../../../shared/constants/enums.js";
import { getReelPreviewService } from "../reels/reelPreview.service.js";

function videoError(message, statusCode, code) {
  return new ApiError(message, statusCode, [{ code }]);
}

let productionService;

export async function getEditorialVideoService() {
  if (!productionService) {
    const [{ createEditorialVideoRepository },
      { createYouTubeVerifier }, { createEditorialCoverService },
      { createEditorialCoverRepository }, { createEditorialCoverStore }] = await Promise.all([
      import("./editorialVideo.repository.js"),
      import("./youtubeVerifier.js"),
      import("./editorialCover.service.js"), import("./editorialCover.repository.js"),
      import("./editorialCover.store.js"),
    ]);
    productionService = createEditorialVideoService({
      repository: createEditorialVideoRepository({ libraryId: getVideosStreamConfiguration().stream?.libraryId }),
      verifyYouTube: createYouTubeVerifier({ apiKey: process.env.YOUTUBE_DATA_API_KEY }),
      covers: createEditorialCoverService({ repository: createEditorialCoverRepository(), store: createEditorialCoverStore() }),
      verifyReelReady: async (video) =>
        (await getReelPreviewService()).verifyReady(video),
      verifyReelReplacementReady: async (video) =>
        (await getReelPreviewService()).verifyReady(video, videoPreviewSelectionEnum.PENDING),
    });
  }
  return productionService;
}






function editMode(current, actor) {
  if (!Object.values(editorialVideoKindEnum).includes(current.kind) || current.status === editorialVideoStatusEnum.IN_REVIEW) {
    throw videoError("Video cannot be edited now", 409, "VIDEO_STATE_CONFLICT");
  }
  if (actor.role === roles.ADMIN && ((current.kind === editorialVideoKindEnum.REEL && current.status === editorialVideoStatusEnum.DRAFT &&
      current.autoPublishWhenReady) || current.pendingChange?.autoApplyWhenReady)) {
    throw videoError("Not allowed to edit an automatic Reel change", 403, "VIDEO_FORBIDDEN");
  }
  const reviewed = actor.role === roles.ADMIN && [editorialVideoStatusEnum.APPROVED, editorialVideoStatusEnum.PUBLISHED, editorialVideoStatusEnum.UNPUBLISHED].includes(current.status);
  const ownAutomatic = actor.role === roles.SUPER_ADMIN && current.pendingChange?.autoApplyWhenReady &&
    current.pendingChange.status === editorialReviewStatusEnum.DRAFT && String(current.pendingChange.authorId) === String(actor.id);
  if (current.pendingChange && (reviewed
    ? String(current.pendingChange.authorId) !== String(actor.id) || current.pendingChange.status === editorialReviewStatusEnum.IN_REVIEW
    : !ownAutomatic)) throw videoError("Video already has a pending change", 409, "VIDEO_STATE_CONFLICT");
  return { reviewed, ownAutomatic };
}

function currentContent(video) {
  return { kind: video.kind, title_en: video.title_en, title_ar: video.title_ar,
    description_en: video.description_en, description_ar: video.description_ar,
    ...(video.kind === editorialVideoKindEnum.YOUTUBE ? { youtubeId: video.youtubeId } : {}),
    ...(video.activeCoverId !== undefined ? { coverId: video.activeCoverId } : {}) };
}

export function createEditorialVideoService({ repository, verifyYouTube, covers, enqueue = enqueueVideoProviderOperation,
  verifyReelReady = async () => false, verifyReelReplacementReady = async () => false,
  now = () => new Date() }) {
  if (!repository?.create || typeof verifyYouTube !== "function") {
    throw new TypeError("Editorial Videos require a repository and YouTube verifier");
  }

  async function finishCommit(promise) {
    const result = await promise;
    await enqueueVideoProviderOperations([result?.operationId, ...(result?.operationIds ?? []),
      ...(result?.coverOperationIds ?? [])], enqueue);
    return result?.video ?? null;
  }

  async function verifyEditorialMedia(video) {
    if (video.kind === editorialVideoKindEnum.YOUTUBE) return verifyYouTube(video.youtubeId);
    if (video.kind === editorialVideoKindEnum.REEL && video.activeAssetId && await verifyReelReady(video)) return;
    throw videoError("Reel is not ready for review or publication", 409, "VIDEO_ASSET_NOT_READY");
  }
  async function verifyPendingMedia(video) {
    const pending = video.pendingChange;
    if (!pending.uploadSessionId && !pending.assetId) {
      return verifyEditorialMedia({ ...video, ...pending.content, kind: video.kind });
    }
    if (video.kind === editorialVideoKindEnum.REEL && pending.uploadSessionId && pending.assetId &&
        await verifyReelReplacementReady(video)) return;
    throw videoError("Reel replacement is not ready for review", 409, "VIDEO_ASSET_NOT_READY");
  }

  return Object.freeze({
    async getAdmin({ id, actor }) {
      if (![roles.ADMIN, roles.SUPER_ADMIN].includes(actor?.role) || !actor?.id) {
        throw videoError("Not allowed to inspect Videos", 403, "VIDEO_FORBIDDEN");
      }
      const video = await repository.get(id);
      if (!video) throw videoError("Video not found", 404, "VIDEO_NOT_FOUND");
      return covers ? covers.describe(video) : video;
    },
    async listAdmin({ actor, page = 1, limit = 20, kind, status }) {
      if (![roles.ADMIN, roles.SUPER_ADMIN].includes(actor?.role) || !actor?.id) {
        throw videoError("Not allowed to list Videos", 403, "VIDEO_FORBIDDEN");
      }
      const { page: pageNumber, limit: limitNumber } = pagination(page, limit);
      const filter = adminDraftFilter(kind, status);
      const { totalResults, data } = await repository.list({ page: pageNumber, limit: limitNumber, ...filter });
      return { totalResults, totalPages: Math.ceil(totalResults / limitNumber) || 1,
        page: pageNumber, results: data.length, data };
    },
    async createYouTubeVideo({ actor, input }) {
      if (![roles.ADMIN, roles.SUPER_ADMIN].includes(actor?.role) || !actor?.id) {
        throw videoError("Not allowed to create a Video", 403, "VIDEO_FORBIDDEN");
      }
      const content = normalizedYouTubeInput(input);
      await verifyYouTube(content.youtubeId);
      const published = actor.role === roles.SUPER_ADMIN;
      return repository.create({
        kind: editorialVideoKindEnum.YOUTUBE,
        ...content,
        status: published ? editorialVideoStatusEnum.PUBLISHED : editorialVideoStatusEnum.DRAFT,
        authorId: actor.id,
        publishedAt: published ? now() : null,
        pendingChange: null,
      });
    },
    async createReelDraft({ actor, input }) {
      if (![roles.ADMIN, roles.SUPER_ADMIN].includes(actor?.role) || !actor?.id) {
        throw videoError("Not allowed to create a Reel", 403, "VIDEO_FORBIDDEN");
      }
      const content = normalizedReelInput(input);
      return repository.create({
        kind: editorialVideoKindEnum.REEL, ...content, status: editorialVideoStatusEnum.DRAFT, authorId: actor.id,
        autoPublishWhenReady: actor.role === roles.SUPER_ADMIN,
        publishedAt: null, pendingChange: null,
      });
    },
    async editVideo({ id, actor, input }) {
      if (![roles.ADMIN, roles.SUPER_ADMIN].includes(actor?.role) || !actor?.id) {
        throw videoError("Not allowed to edit a Video", 403, "VIDEO_FORBIDDEN");
      }
      const current = await repository.get(id);
      if (!current) throw videoError("Video not found", 404, "VIDEO_NOT_FOUND");
      const mode = editMode(current, actor);
      let next;
      if (mode.reviewed) {
        const content = editedContent(current.kind, current.pendingChange?.content ?? current, input);
        if (current.kind === editorialVideoKindEnum.YOUTUBE) await verifyYouTube(content.youtubeId);
        next = { ...current, pendingChange: {
          ...current.pendingChange,
          authorId: actor.id,
          status: editorialReviewStatusEnum.DRAFT,
          content: { ...currentContent(current), ...current.pendingChange?.content, ...content },
          createdAt: current.pendingChange?.createdAt ?? now(),
          updatedAt: now(),
          reviewReason: null,
        } };
      } else {
        const content = editedContent(current.kind, current, input);
        if (current.kind === editorialVideoKindEnum.YOUTUBE) await verifyYouTube(content.youtubeId);
        next = { ...current, ...content };
        if (mode.ownAutomatic) next.pendingChange = { ...current.pendingChange,
          content: { ...current.pendingChange.content, kind: current.kind, ...content }, updatedAt: now() };
      }
      const updated = await repository.replace(id, current.revision, next);
      if (!updated) throw videoError("Video changed concurrently", 409, "VIDEO_STATE_CONFLICT");
      return updated;
    },
    async editCover({ id, actor, buffer, remove = false }) {
      if (![roles.ADMIN, roles.SUPER_ADMIN].includes(actor?.role) || !actor?.id) {
        throw videoError("Not allowed to edit a Video", 403, "VIDEO_FORBIDDEN");
      }
      if (typeof remove !== "boolean" || (remove && buffer !== undefined)) {
        throw videoError("Invalid cover edit", 422, "VIDEO_INVALID_COVER");
      }
      const current = await repository.get(id);
      if (!current) throw videoError("Video not found", 404, "VIDEO_NOT_FOUND");
      const mode = editMode(current, actor);
      if (!covers || !repository.replaceWithCovers) throw videoError("Cover editing is unavailable", 503, "VIDEO_COVER_DISABLED");
      const staged = remove ? null : await covers.stageUpload({ videoId: id, actor, buffer });
      const coverId = staged ? String(staged._id) : null;
      const next = mode.reviewed ? { ...current, pendingChange: {
        ...current.pendingChange, authorId: actor.id, status: editorialReviewStatusEnum.DRAFT,
        content: { ...currentContent(current), ...current.pendingChange?.content, coverId },
        createdAt: current.pendingChange?.createdAt ?? now(), updatedAt: now(), reviewReason: null,
      } } : { ...current, activeCoverId: coverId,
        ...(mode.ownAutomatic ? { pendingChange: { ...current.pendingChange,
          content: { ...current.pendingChange.content, coverId }, updatedAt: now() } } : {}) };
      try {
        const updated = await finishCommit(repository.replaceWithCovers(id, current.revision, next, { actorId: actor.id, now: now() }));
        if (!updated) throw videoError("Video changed concurrently", 409, "VIDEO_STATE_CONFLICT");
        return covers.describe(updated);
      } catch (error) {
        if (staged) {
          try { await covers.discardUnused({ coverId }); } catch { /* The unattached reservation remains sweepable. */ }
        }
        throw error;
      }
    },
    async cancelPendingChange({ id, actor }) {
      if (![roles.ADMIN, roles.SUPER_ADMIN].includes(actor?.role) || !actor?.id) {
        throw videoError("Not allowed to cancel this change", 403, "VIDEO_FORBIDDEN");
      }
      const current = await repository.get(id);
      if (!current) throw videoError("Video not found", 404, "VIDEO_NOT_FOUND");
      if (!current.pendingChange || !Object.values(editorialVideoKindEnum).includes(current.kind)) {
        throw videoError("Video has no pending change", 409, "VIDEO_STATE_CONFLICT");
      }
      if (actor?.role !== roles.SUPER_ADMIN &&
          !(actor?.role === roles.ADMIN && actor.id &&
            String(actor.id) === String(current.pendingChange.authorId))) {
        throw videoError("Not allowed to cancel this change", 403, "VIDEO_FORBIDDEN");
      }
      if (current.pendingChange.uploadSessionId || current.pendingChange.assetId) {
        if (current.kind !== editorialVideoKindEnum.REEL || !current.pendingChange.uploadSessionId) {
          throw videoError("Invalid Reel replacement binding", 409, "VIDEO_UPLOAD_CONFLICT");
        }
        const updated = await finishCommit(repository.cancelReelPendingChange({ videoId: id, actor,
          expectedRevision: current.revision, sessionId: current.pendingChange.uploadSessionId,
          assetId: current.pendingChange.assetId }));
        if (!updated) throw videoError("Video changed concurrently", 409, "VIDEO_STATE_CONFLICT");
        return updated;
      }
      const updated = current.pendingChange.content?.coverId
        ? await finishCommit(repository.replaceWithCovers(id, current.revision, { ...current, pendingChange: null }, { now: now() }))
        : await repository.replace(id, current.revision, { ...current, pendingChange: null });
      if (!updated) throw videoError("Video changed concurrently", 409, "VIDEO_STATE_CONFLICT");
      return updated;
    },
    async submit({ id, actor }) {
      const current = await repository.get(id);
      if (!current) throw videoError("Video not found", 404, "VIDEO_NOT_FOUND");
      if (actor?.role !== roles.ADMIN || !actor.id) {
        throw videoError("Not allowed to submit this Video", 403, "VIDEO_FORBIDDEN");
      }
      if (current.pendingChange) {
        if (String(actor.id) !== String(current.pendingChange.authorId)) {
          throw videoError("Not allowed to submit this change", 403, "VIDEO_FORBIDDEN");
        }
        if (current.pendingChange.autoApplyWhenReady) {
          throw videoError("Not allowed to submit an automatically applied change", 403, "VIDEO_FORBIDDEN");
        }
        if (![editorialReviewStatusEnum.DRAFT, editorialReviewStatusEnum.REJECTED].includes(current.pendingChange.status)) {
          throw videoError("Change cannot be submitted", 409, "VIDEO_STATE_CONFLICT");
        }
        await verifyPendingMedia(current);
        const updated = await repository.replace(id, current.revision, {
          ...current,
          pendingChange: { ...current.pendingChange, status: editorialReviewStatusEnum.IN_REVIEW, reviewReason: null,
            submittedAt: now(),
            ...(current.kind === editorialVideoKindEnum.REEL ? { rejectedAssetExpiresAt: null } : {}) },
        });
        if (!updated) throw videoError("Video changed concurrently", 409, "VIDEO_STATE_CONFLICT");
        return updated;
      }
      if (String(actor.id) !== String(current.authorId)) {
        throw videoError("Not allowed to submit this Video", 403, "VIDEO_FORBIDDEN");
      }
      if (current.status !== editorialVideoStatusEnum.DRAFT) {
        throw videoError("Video cannot be submitted", 409, "VIDEO_STATE_CONFLICT");
      }
      await verifyEditorialMedia(current);
      const updated = await repository.replace(id, current.revision, {
        ...current,
        status: editorialVideoStatusEnum.IN_REVIEW,
      });
      if (!updated) throw videoError("Video changed concurrently", 409, "VIDEO_STATE_CONFLICT");
      return updated;
    },
    async approve({ id, actor }) {
      if (actor?.role !== roles.SUPER_ADMIN || !actor.id) {
        throw videoError("Not allowed to approve a Video", 403, "VIDEO_FORBIDDEN");
      }
      const current = await repository.get(id);
      if (!current) throw videoError("Video not found", 404, "VIDEO_NOT_FOUND");
      if (Object.values(editorialVideoKindEnum).includes(current.kind) && current.pendingChange?.status === editorialReviewStatusEnum.IN_REVIEW &&
          [editorialVideoStatusEnum.APPROVED, editorialVideoStatusEnum.PUBLISHED, editorialVideoStatusEnum.UNPUBLISHED].includes(current.status)) {
        await verifyPendingMedia(current);
        if (current.pendingChange.uploadSessionId || current.pendingChange.assetId) {
          const updated = await finishCommit(repository.applyReelReplacement({ videoId: id,
            expectedRevision: current.revision, sessionId: current.pendingChange.uploadSessionId,
            assetId: current.pendingChange.assetId, reviewerId: actor.id, now: now() }));
          if (!updated) throw videoError("Video changed concurrently", 409, "VIDEO_STATE_CONFLICT");
          return updated;
        }
        const { coverId, ...content } = current.pendingChange.content;
        const next = {
          ...current,
          ...content,
          ...(Object.hasOwn(current.pendingChange.content, "coverId") ? { activeCoverId: coverId } : {}),
          pendingChange: null,
          reviewerId: actor.id,
          reviewedAt: now(),
        };
        const updated = Object.hasOwn(current.pendingChange.content, "coverId")
          ? await finishCommit(repository.replaceWithCovers(id, current.revision, next, { now: now() }))
          : await repository.replace(id, current.revision, next);
        if (!updated) throw videoError("Video changed concurrently", 409, "VIDEO_STATE_CONFLICT");
        return updated;
      }
      if (current.status !== editorialVideoStatusEnum.IN_REVIEW || !Object.values(editorialVideoKindEnum).includes(current.kind)) {
        throw videoError("Video cannot be approved", 409, "VIDEO_STATE_CONFLICT");
      }
      await verifyEditorialMedia(current);
      const updated = await repository.replace(id, current.revision, {
        ...current,
        status: editorialVideoStatusEnum.APPROVED,
        reviewerId: actor.id,
        reviewedAt: now(),
      });
      if (!updated) throw videoError("Video changed concurrently", 409, "VIDEO_STATE_CONFLICT");
      return updated;
    },
    async reject({ id, actor, reason }) {
      if (actor?.role !== roles.SUPER_ADMIN || !actor.id) {
        throw videoError("Not allowed to reject a Video", 403, "VIDEO_FORBIDDEN");
      }
      const safeReason = normalizedText(reason, "reason", { required: true, maxLength: 500 });
      const current = await repository.get(id);
      if (!current) throw videoError("Video not found", 404, "VIDEO_NOT_FOUND");
      if (Object.values(editorialVideoKindEnum).includes(current.kind) && current.pendingChange?.status === editorialReviewStatusEnum.IN_REVIEW &&
          [editorialVideoStatusEnum.APPROVED, editorialVideoStatusEnum.PUBLISHED, editorialVideoStatusEnum.UNPUBLISHED].includes(current.status)) {
        const reviewedAt = now();
        const updated = await repository.replace(id, current.revision, {
          ...current,
          pendingChange: { ...current.pendingChange, status: editorialReviewStatusEnum.REJECTED, reviewReason: safeReason,
            reviewedAt,
            ...(current.kind === editorialVideoKindEnum.REEL && current.pendingChange.assetId && current.pendingChange.uploadSessionId
              ? { rejectedAssetExpiresAt: new Date(reviewedAt.getTime() + 7 * 24 * 60 * 60_000) } : {}) },
        });
        if (!updated) throw videoError("Video changed concurrently", 409, "VIDEO_STATE_CONFLICT");
        return updated;
      }
      if (current.status !== editorialVideoStatusEnum.IN_REVIEW || !Object.values(editorialVideoKindEnum).includes(current.kind)) {
        throw videoError("Video cannot be rejected", 409, "VIDEO_STATE_CONFLICT");
      }
      const updated = await repository.replace(id, current.revision, {
        ...current,
        status: editorialVideoStatusEnum.DRAFT,
        reviewReason: safeReason,
        reviewerId: actor.id,
        reviewedAt: now(),
      });
      if (!updated) throw videoError("Video changed concurrently", 409, "VIDEO_STATE_CONFLICT");
      return updated;
    },
    async publish({ id, actor }) {
      if (actor?.role !== roles.SUPER_ADMIN || !actor.id) {
        throw videoError("Not allowed to publish a Video", 403, "VIDEO_FORBIDDEN");
      }
      const current = await repository.get(id);
      if (!current) throw videoError("Video not found", 404, "VIDEO_NOT_FOUND");
      if (![editorialVideoStatusEnum.APPROVED, editorialVideoStatusEnum.UNPUBLISHED].includes(current.status) ||
          !Object.values(editorialVideoKindEnum).includes(current.kind)) {
        throw videoError("Video cannot be published", 409, "VIDEO_STATE_CONFLICT");
      }
      await verifyEditorialMedia(current);
      const updated = await repository.replace(id, current.revision, {
        ...current,
        status: editorialVideoStatusEnum.PUBLISHED,
        publishedAt: now(),
      });
      if (!updated) throw videoError("Video changed concurrently", 409, "VIDEO_STATE_CONFLICT");
      return updated;
    },
    async unpublish({ id, actor }) {
      if (actor?.role !== roles.SUPER_ADMIN || !actor.id) {
        throw videoError("Not allowed to unpublish a Video", 403, "VIDEO_FORBIDDEN");
      }
      const current = await repository.get(id);
      if (!current) throw videoError("Video not found", 404, "VIDEO_NOT_FOUND");
      if (current.status !== editorialVideoStatusEnum.PUBLISHED || !Object.values(editorialVideoKindEnum).includes(current.kind)) {
        throw videoError("Video cannot be unpublished", 409, "VIDEO_STATE_CONFLICT");
      }
      const updated = await repository.replace(id, current.revision, {
        ...current,
        status: editorialVideoStatusEnum.UNPUBLISHED,
        unpublishedAt: now(),
      });
      if (!updated) throw videoError("Video changed concurrently", 409, "VIDEO_STATE_CONFLICT");
      return updated;
    },
    async deletePermanently({ id, actor, input }) {
      if (actor?.role !== roles.SUPER_ADMIN || !actor.id) {
        throw videoError("Not allowed to delete Videos", 403, "VIDEO_FORBIDDEN");
      }
      validatePermanentDeletion(id, input);
      const result = await repository.deletePermanently({ id: id.toLowerCase(), revision: input.revision, now: now() });
      await enqueueVideoProviderOperations(result.operationIds, enqueue);
      return { videoId: id.toLowerCase(), status: "removed" };
    },
    async setDraftPosition({ id, actor, input }) {
      if (![roles.ADMIN, roles.SUPER_ADMIN].includes(actor?.role) || !actor?.id) {
        throw videoError("Not allowed to arrange drafts", 403, "VIDEO_FORBIDDEN");
      }
      validateDraftPosition(input);
      const current = await repository.get(id);
      if (!current) throw videoError("Video not found", 404, "VIDEO_NOT_FOUND");
      if (current.status !== editorialVideoStatusEnum.DRAFT) throw videoError("Video is not a draft", 409, "VIDEO_STATE_CONFLICT");
      editMode(current, actor);
      if (current.revision !== input.revision) throw videoError("Video changed concurrently", 409, "VIDEO_STATE_CONFLICT");
      const updated = await repository.setDraftPosition(id, input.revision, input.draftPosition);
      if (!updated) throw videoError("Video changed concurrently", 409, "VIDEO_STATE_CONFLICT");
      return { videoId: updated.id, draftPosition: updated.draftPosition, revision: updated.revision };
    },
    async setPublicPositions({ actor, input }) {
      if (actor?.role !== roles.SUPER_ADMIN || !actor.id) {
        throw videoError("Not allowed to order Videos", 403, "VIDEO_FORBIDDEN");
      }
      const positions = validatePublicPositions(input);
      return repository.setPublicPositions(positions);
    },
    async setPublicPosition({ id, actor, input }) {
      if (actor?.role !== roles.SUPER_ADMIN || !actor.id) {
        throw videoError("Not allowed to order Videos", 403, "VIDEO_FORBIDDEN");
      }
      validatePublicPosition(input);
      const current = await repository.get(id);
      if (!current) throw videoError("Video not found", 404, "VIDEO_NOT_FOUND");
      if (!Object.values(editorialVideoKindEnum).includes(current.kind) || current.status !== editorialVideoStatusEnum.PUBLISHED) {
        throw videoError("Video cannot be ordered now", 409, "VIDEO_STATE_CONFLICT");
      }
      const updated = await repository.replace(id, current.revision,
        { ...current, position: input.position });
      if (!updated) throw videoError("Video changed concurrently", 409, "VIDEO_STATE_CONFLICT");
      return updated;
    },
  });
}
