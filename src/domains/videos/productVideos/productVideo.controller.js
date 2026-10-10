import { videoUploadResponseStatusEnum } from "../../../shared/constants/enums.js";
import asyncHandler from "express-async-handler";

import { getProductVideoService } from "./productVideo.service.js";
import { getProductVideoPreviewService } from "./productVideoPreview.service.js";

export function createProductVideoController({
  getService = getProductVideoService, getPreviewService = getProductVideoPreviewService
} = {}) {
  return Object.freeze({
    preview: asyncHandler(async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const data = await getPreviewService().grant({ productId: req.params.id,
        videoId: req.params.videoId, asset: req.query.asset,
        actor: { id: req.user?._id, role: req.user?.role, enabledControls: req.user?.enabledControls },
      });
      res.status(200).json({ data });
    }),
    listAdminStatus: asyncHandler(async (req, res) => {
      const data = await getService().listAdminStatus({ productId: req.params.id });
      res.status(200).json({ data });
    }),
    createUploadSessions: asyncHandler(async (req, res) => {
      const data = await getService().createUploadSessions({
        productId: req.params.id,
        actorId: req.user?._id,
        idempotencyKey: req.get("Idempotency-Key"),
        files: req.body?.files,
      });
      res.status(201).json({ data });
    }),
    refreshUploadAuthorization: asyncHandler(async (req, res) => {
      const data = await getService().refreshUploadAuthorization({
        productId: req.params.id,
        videoId: req.params.videoId,
      });
      res.status(200).json({ data });
    }),
    recoverUploadSession: asyncHandler(async (req, res) => {
      const data = await getService().recoverUploadSession({ productId: req.params.id,
        videoId: req.params.videoId, replacementId: req.params.replacementId,
        actorId: req.user?._id, idempotencyKey: req.get("Idempotency-Key"), file: req.body.file });
      res.set("Cache-Control", "private, no-store");
      res.status(data.status === videoUploadResponseStatusEnum.RECOVERING ? 202 : 201).json({ data });
    }),
    createReplacementUploadSession: asyncHandler(async (req, res) => {
      const data = await getService().createReplacementUploadSession({
        productId: req.params.id, videoId: req.params.videoId, actorId: req.user?._id,
        idempotencyKey: req.get("Idempotency-Key"), file: req.body?.file,
      });
      res.status(201).json({ data });
    }),
    refreshReplacementAuthorization: asyncHandler(async (req, res) => {
      const data = await getService().refreshReplacementAuthorization({
        productId: req.params.id, videoId: req.params.videoId, replacementId: req.params.replacementId,
      });
      res.status(200).json({ data });
    }),
    cancelReplacementUpload: asyncHandler(async (req, res) => {
      const data = await getService().cancelReplacementUpload({
        productId: req.params.id, videoId: req.params.videoId, replacementId: req.params.replacementId,
      });
      res.status(202).json({ data });
    }),
    cancelPendingUpload: asyncHandler(async (req, res) => {
      const data = await getService().cancelPendingUpload({
        productId: req.params.id,
        videoId: req.params.videoId,
      });
      res.status(202).json({ data });
    }),
    setReelsVisibility: asyncHandler(async (req, res) => {
      const data = await getService().setReelsVisibility({
        productId: req.params.id,
        videoId: req.params.videoId,
        showInReelsFeed: req.body.showInReelsFeed,
      });
      res.status(200).json({ data });
    }),
    requestDeletion: asyncHandler(async (req, res) => {
      const data = await getService().requestDeletion({
        productId: req.params.id,
        videoId: req.params.videoId,
      });
      res.status(202).json({ data });
    }),
  });
}
