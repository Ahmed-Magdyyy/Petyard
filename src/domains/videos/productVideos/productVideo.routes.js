import { Router } from "express";
import { protect, allowedTo, enabledControls as enabledControlsMiddleware } from "../../auth/auth.middleware.js";
import { roles, enabledControls } from "../../../shared/constants/enums.js";
import { createProductVideoController } from "./productVideo.controller.js";
import { createProductVideoUploadGuard } from "./productVideo.middleware.js";
import { productVideoVisibilityValidator, productVideoUploadRecoveryValidator } from "./productVideo.validators.js";

export function createProductVideoRouter({
  access = [protect, allowedTo(roles.SUPER_ADMIN, roles.ADMIN), enabledControlsMiddleware(enabledControls.PRODUCTS)],
  isUploadEnabled, getService, getPreviewService
} = {}) {
  const router = Router({ mergeParams: true });
  const controller = createProductVideoController({ getService, getPreviewService });
  const requireUploads = createProductVideoUploadGuard({ isUploadEnabled });
  router.get("/:videoId/preview", ...access, controller.preview);
  router.get("/", ...access, controller.listAdminStatus);
  router.post("/upload-sessions", ...access, requireUploads, controller.createUploadSessions);
  router.post("/:videoId/upload-authorization", ...access, controller.refreshUploadAuthorization);
  router.post("/:videoId/upload-recovery", ...access, productVideoUploadRecoveryValidator, controller.recoverUploadSession);
  router.post("/:videoId/replacement-upload-session", ...access, requireUploads, controller.createReplacementUploadSession);
  router.post("/:videoId/replacements/:replacementId/upload-authorization", ...access, controller.refreshReplacementAuthorization);
  router.post("/:videoId/replacements/:replacementId/upload-recovery", ...access,
    productVideoUploadRecoveryValidator, controller.recoverUploadSession);
  router.delete("/:videoId/replacements/:replacementId/upload-session", ...access, controller.cancelReplacementUpload);
  router.delete("/:videoId/upload-session", ...access, controller.cancelPendingUpload);
  router.patch("/:videoId", ...access, productVideoVisibilityValidator, controller.setReelsVisibility);
  router.delete("/:videoId", ...access, controller.requestDeletion);
  return router;
}

export default createProductVideoRouter();
