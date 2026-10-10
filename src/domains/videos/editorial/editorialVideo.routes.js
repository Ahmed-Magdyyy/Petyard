import { Router } from "express";
import { protect, allowedTo, enabledControls as requireControl } from "../../auth/auth.middleware.js";
import { roles, enabledControls } from "../../../shared/constants/enums.js";
import { createEditorialVideoController } from "./editorialVideo.controller.js";
import { createEditorialVideoGuards, uploadEditorialCover } from "./editorialVideo.middleware.js";
import { coverUploadValidator, coverRemovalValidator, publicPositionsValidator, draftPositionValidator,
  permanentDeletionValidator } from "./editorialVideo.validators.js";
import { reelResourceRecoveryValidator } from "../reels/reelUpload.validators.js";

export function createEditorialVideoRouter({
  access = [protect, allowedTo(roles.SUPER_ADMIN, roles.ADMIN), requireControl(enabledControls.VIDEOS)],
  reviewAccess = [allowedTo(roles.SUPER_ADMIN)],
  getService, getUploadService, getPreviewService,
  isReelUploadEnabled, isReelPipelineReady, isCoverPipelineReady
} = {}) {
  const router = Router();
  const controller = createEditorialVideoController({ getService, getUploadService, getPreviewService });
  const guards = createEditorialVideoGuards({ isReelUploadEnabled, isReelPipelineReady, isCoverPipelineReady });
  router.use(...access);
  router.get("/", controller.listAdmin);
  router.patch("/positions", ...reviewAccess, publicPositionsValidator, controller.setPublicPositions);
  router.get("/:id", controller.getAdmin);
  router.get("/:id/preview", controller.preview);
  router.post("/", controller.createVideo);
  router.post("/:id/upload-session", guards.requireReelUploads, controller.createUploadSession);
  router.post("/:id/replacement-upload-session", guards.requireReelUploads, controller.createReplacementUploadSession);
  router.get("/:id/replacement-upload-session", controller.getReplacementUploadStatus);
  router.post("/:id/replacement-upload-sessions/:sessionId/authorization", controller.refreshReplacementUploadAuthorization);
  router.post("/:id/replacement-upload-sessions/:sessionId/recovery", reelResourceRecoveryValidator, controller.recoverReplacementUpload);
  router.delete("/:id/replacement-upload-sessions/:sessionId", controller.cancelReplacementUpload);
  router.get("/:id/upload-session", controller.getUploadStatus);
  router.post("/:id/upload-sessions/:sessionId/authorization", controller.refreshUploadAuthorization);
  router.post("/:id/upload-sessions/:sessionId/recovery", reelResourceRecoveryValidator, controller.recoverUpload);
  router.delete("/:id/upload-sessions/:sessionId", controller.cancelUpload);
  router.post("/:id/submit", controller.submit);
  router.post("/:id/approve", ...reviewAccess, controller.approve);
  router.post("/:id/reject", ...reviewAccess, controller.reject);
  router.post("/:id/publish", ...reviewAccess, controller.publish);
  router.post("/:id/unpublish", ...reviewAccess, controller.unpublish);
  router.patch("/:id/position", ...reviewAccess, controller.setPublicPosition);
  router.patch("/:id/draft-position", draftPositionValidator, controller.setDraftPosition);
  router.post("/:id/cover", guards.requireCoverUploads, uploadEditorialCover, coverUploadValidator, controller.uploadCover);
  router.delete("/:id/cover", coverRemovalValidator, controller.removeCover);
  router.delete("/:id/pending-change", controller.cancelPendingChange);
  router.delete("/:id", ...reviewAccess, permanentDeletionValidator, controller.deletePermanently);
  router.patch("/:id", controller.editVideo);
  return router;
}

export default createEditorialVideoRouter();
