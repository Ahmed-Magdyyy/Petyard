import { Router } from "express";
import { protect, allowedTo, optionalProtect } from "../auth/auth.middleware.js";
import { roles } from "../../shared/constants/enums.js";
import { previewReadLimiter, previewCreateLimiter } from "./uiLayout.limiters.js";
import {
  uploadUiBuilderImage, requireUiLayoutReleaseEnabled, uiLayoutErrorHandler,
} from "./uiLayout.middleware.js";
import {
  listAssetsValidator, createDraftValidator, listDraftsValidator, draftIdValidator,
  saveDraftValidator, emptyDraftBodyValidator, createPreviewValidator, previewIdValidator,
  publishDraftValidator, historyValidator, versionIdValidator, rollbackValidator,
  auditValidator, publishedLayoutValidator,
} from "./uiLayout.validators.js";
import {
  getCatalog, uploadAsset, listAssets, createDraft, listDrafts, getDraft, saveDraft, archiveDraft,
  validateDraft, createPreview, getPreview, revokePreview, publishDraft,
  cancelSchedule, listHistory, getVersion, rollbackVersion, getAudit, getPublishedLayout,
} from "./uiLayout.controller.js";

export const publicUiLayoutRouter = Router();
publicUiLayoutRouter.get("/customer_home", optionalProtect, publishedLayoutValidator, getPublishedLayout);
publicUiLayoutRouter.use(uiLayoutErrorHandler);

export const publicUiLayoutPreviewRouter = Router();
publicUiLayoutPreviewRouter.get("/", previewReadLimiter, getPreview);
publicUiLayoutPreviewRouter.use(uiLayoutErrorHandler);

export const adminUiBuilderRouter = Router();
adminUiBuilderRouter.use(protect, allowedTo(roles.SUPER_ADMIN));
adminUiBuilderRouter.get("/catalog", getCatalog);
adminUiBuilderRouter.post("/assets", uploadUiBuilderImage, uploadAsset);
adminUiBuilderRouter.get("/assets", listAssetsValidator, listAssets);
adminUiBuilderRouter.use(uiLayoutErrorHandler);

export const adminUiLayoutRouter = Router();
adminUiLayoutRouter.use(protect, allowedTo(roles.SUPER_ADMIN));
adminUiLayoutRouter.post("/drafts", createDraftValidator, createDraft);
adminUiLayoutRouter.get("/drafts", listDraftsValidator, listDrafts);
adminUiLayoutRouter.get("/drafts/:draftId", draftIdValidator, getDraft);
adminUiLayoutRouter.patch("/drafts/:draftId", saveDraftValidator, saveDraft);
adminUiLayoutRouter.delete("/drafts/:draftId", draftIdValidator, archiveDraft);
adminUiLayoutRouter.post("/drafts/:draftId/validate", emptyDraftBodyValidator, validateDraft);
adminUiLayoutRouter.post("/drafts/:draftId/preview", previewCreateLimiter, createPreviewValidator, createPreview);
adminUiLayoutRouter.post("/drafts/:draftId/publish", requireUiLayoutReleaseEnabled, publishDraftValidator, publishDraft);
adminUiLayoutRouter.post("/drafts/:draftId/cancel-schedule", emptyDraftBodyValidator, cancelSchedule);
adminUiLayoutRouter.delete("/previews/:previewId", previewIdValidator, revokePreview);
adminUiLayoutRouter.get("/history", historyValidator, listHistory);
adminUiLayoutRouter.get("/versions/:versionId", versionIdValidator, getVersion);
adminUiLayoutRouter.post("/versions/:versionId/rollback", requireUiLayoutReleaseEnabled, rollbackValidator, rollbackVersion);
adminUiLayoutRouter.get("/audit", auditValidator, getAudit);
adminUiLayoutRouter.use(uiLayoutErrorHandler);
