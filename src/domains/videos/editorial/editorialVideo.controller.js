import { editorialVideoKindEnum, reelUploadPurposeEnum, videoUploadResponseStatusEnum } from "../../../shared/constants/enums.js";
import asyncHandler from "express-async-handler";

import { getEditorialVideoService } from "./editorialVideo.service.js";
import { getReelUploadService } from "../reels/reelUpload.service.js";
import { getReelPreviewService } from "../reels/reelPreview.service.js";

export function createEditorialVideoController({
  getService = getEditorialVideoService, getUploadService = getReelUploadService,
  getPreviewService = getReelPreviewService
} = {}) {
  return Object.freeze({
    deletePermanently: asyncHandler(async (req, res) => {
      const app = await getService();
      const data = await app.deletePermanently({ id: req.params.id,
        actor: { id: req.user?._id, role: req.user?.role }, input: req.body });
      res.set("Cache-Control", "private, no-store");
      res.status(202).json({ data });
    }),
    listAdmin: asyncHandler(async (req, res) => {
      const app = await getService();
      const data = await app.listAdmin({ actor: { id: req.user?._id, role: req.user?.role },
        page: req.query.page, limit: req.query.limit, kind: req.query.kind, status: req.query.status });
      res.set("Cache-Control", "private, no-store");
      res.status(200).json({ data });
    }),
    getAdmin: asyncHandler(async (req, res) => {
      const app = await getService();
      const data = await app.getAdmin({ id: req.params.id,
        actor: { id: req.user?._id, role: req.user?.role } });
      res.status(200).json({ data });
    }),
    preview: asyncHandler(async (req, res) => {
      const app = await getPreviewService();
      const data = await app.grant({ id: req.params.id,
        asset: req.query.asset,
        actor: { id: req.user?._id, role: req.user?.role } });
      res.set("Cache-Control", "private, no-store");
      res.status(200).json({ data });
    }),
    createVideo: asyncHandler(async (req, res) => {
      const app = await getService();
      const create = req.body?.kind === editorialVideoKindEnum.REEL ? app.createReelDraft : app.createYouTubeVideo;
      const data = await create({
        actor: { id: req.user?._id, role: req.user?.role }, input: req.body,
      });
      res.status(201).json({ data });
    }),
    createUploadSession: asyncHandler(async (req, res) => {
      const app = await getUploadService();
      const data = await app.createSession({ videoId: req.params.id,
        actor: { id: req.user?._id, role: req.user?.role },
        idempotencyKey: req.get("Idempotency-Key"), file: req.body?.file });
      res.status(data.status === videoUploadResponseStatusEnum.RESERVING ? 202 : 201).json({ data });
    }),
    createReplacementUploadSession: asyncHandler(async (req, res) => {
      const app = await getUploadService();
      const data = await app.createSession({ videoId: req.params.id, purpose: reelUploadPurposeEnum.REPLACEMENT,
        actor: { id: req.user?._id, role: req.user?.role },
        idempotencyKey: req.get("Idempotency-Key"), file: req.body?.file });
      res.set("Cache-Control", "private, no-store");
      res.status(data.status === videoUploadResponseStatusEnum.RESERVING ? 202 : 201).json({ data });
    }),
    getReplacementUploadStatus: asyncHandler(async (req, res) => {
      const app = await getUploadService();
      const data = await app.getUploadStatus({ videoId: req.params.id, purpose: reelUploadPurposeEnum.REPLACEMENT,
        actor: { id: req.user?._id, role: req.user?.role } });
      res.set("Cache-Control", "private, no-store");
      res.status(200).json({ data });
    }),
    recoverReplacementUpload: asyncHandler(async (req, res) => {
      const app = await getUploadService();
      const data = await app.recoverUploadSession({ videoId: req.params.id, sessionId: req.params.sessionId,
        purpose: reelUploadPurposeEnum.REPLACEMENT, actor: { id: req.user?._id, role: req.user?.role },
        idempotencyKey: req.get("Idempotency-Key"), file: req.body.file });
      res.set("Cache-Control", "private, no-store");
      res.status(data.status === videoUploadResponseStatusEnum.RECOVERING ? 202 : 201).json({ data });
    }),
    recoverUpload: asyncHandler(async (req, res) => {
      const app = await getUploadService();
      const data = await app.recoverUploadSession({ videoId: req.params.id, sessionId: req.params.sessionId,
        actor: { id: req.user?._id, role: req.user?.role },
        idempotencyKey: req.get("Idempotency-Key"), file: req.body.file });
      res.set("Cache-Control", "private, no-store");
      res.status(data.status === videoUploadResponseStatusEnum.RECOVERING ? 202 : 201).json({ data });
    }),
    refreshReplacementUploadAuthorization: asyncHandler(async (req, res) => {
      const app = await getUploadService();
      const data = await app.refreshUploadAuthorization({ videoId: req.params.id, purpose: reelUploadPurposeEnum.REPLACEMENT,
        sessionId: req.params.sessionId, actor: { id: req.user?._id, role: req.user?.role } });
      res.set("Cache-Control", "private, no-store");
      res.status(200).json({ data });
    }),
    cancelReplacementUpload: asyncHandler(async (req, res) => {
      const app = await getUploadService();
      const data = await app.cancelUpload({ videoId: req.params.id, purpose: reelUploadPurposeEnum.REPLACEMENT,
        sessionId: req.params.sessionId, actor: { id: req.user?._id, role: req.user?.role } });
      res.set("Cache-Control", "private, no-store");
      res.status(202).json({ data });
    }),
    getUploadStatus: asyncHandler(async (req, res) => {
      const app = await getUploadService();
      const data = await app.getUploadStatus({ videoId: req.params.id,
        actor: { id: req.user?._id, role: req.user?.role } });
      res.set("Cache-Control", "private, no-store");
      res.status(200).json({ data });
    }),
    refreshUploadAuthorization: asyncHandler(async (req, res) => {
      const app = await getUploadService();
      const data = await app.refreshUploadAuthorization({ videoId: req.params.id,
        sessionId: req.params.sessionId, actor: { id: req.user?._id, role: req.user?.role } });
      res.set("Cache-Control", "private, no-store");
      res.status(200).json({ data });
    }),
    cancelUpload: asyncHandler(async (req, res) => {
      const app = await getUploadService();
      const data = await app.cancelUpload({ videoId: req.params.id,
        sessionId: req.params.sessionId, actor: { id: req.user?._id, role: req.user?.role } });
      res.set("Cache-Control", "private, no-store");
      res.status(202).json({ data });
    }),
    submit: asyncHandler(async (req, res) => {
      const app = await getService();
      const data = await app.submit({ id: req.params.id,
        actor: { id: req.user?._id, role: req.user?.role } });
      res.status(200).json({ data });
    }),
    approve: asyncHandler(async (req, res) => {
      const app = await getService();
      const data = await app.approve({ id: req.params.id,
        actor: { id: req.user?._id, role: req.user?.role } });
      res.status(200).json({ data });
    }),
    reject: asyncHandler(async (req, res) => {
      const app = await getService();
      const data = await app.reject({ id: req.params.id,
        actor: { id: req.user?._id, role: req.user?.role }, reason: req.body?.reason });
      res.status(200).json({ data });
    }),
    publish: asyncHandler(async (req, res) => {
      const app = await getService();
      const data = await app.publish({ id: req.params.id,
        actor: { id: req.user?._id, role: req.user?.role } });
      res.status(200).json({ data });
    }),
    unpublish: asyncHandler(async (req, res) => {
      const app = await getService();
      const data = await app.unpublish({ id: req.params.id,
        actor: { id: req.user?._id, role: req.user?.role } });
      res.status(200).json({ data });
    }),
    setDraftPosition: asyncHandler(async (req, res) => {
      const app = await getService();
      const data = await app.setDraftPosition({ id: req.params.id,
        actor: { id: req.user?._id, role: req.user?.role }, input: req.body });
      res.set("Cache-Control", "private, no-store");
      res.status(200).json({ data });
    }),
    setPublicPositions: asyncHandler(async (req, res) => {
      const app = await getService();
      const data = await app.setPublicPositions({
        actor: { id: req.user?._id, role: req.user?.role }, input: req.body,
      });
      res.set("Cache-Control", "private, no-store");
      res.status(200).json({ data });
    }),
    setPublicPosition: asyncHandler(async (req, res) => {
      const app = await getService();
      const data = await app.setPublicPosition({ id: req.params.id,
        actor: { id: req.user?._id, role: req.user?.role }, input: req.body });
      res.status(200).json({ data });
    }),
    uploadCover: asyncHandler(async (req, res) => {
      const app = await getService();
      const data = await app.editCover({ id: req.params.id,
        actor: { id: req.user?._id, role: req.user?.role }, buffer: req.file.buffer });
      res.set("Cache-Control", "private, no-store");
      res.status(200).json({ data });
    }),
    removeCover: asyncHandler(async (req, res) => {
      const app = await getService();
      const data = await app.editCover({ id: req.params.id,
        actor: { id: req.user?._id, role: req.user?.role }, remove: true });
      res.set("Cache-Control", "private, no-store");
      res.status(200).json({ data });
    }),
    cancelPendingChange: asyncHandler(async (req, res) => {
      const app = await getService();
      const data = await app.cancelPendingChange({ id: req.params.id,
        actor: { id: req.user?._id, role: req.user?.role } });
      res.set("Cache-Control", "private, no-store");
      res.status(200).json({ data });
    }),
    editVideo: asyncHandler(async (req, res) => {
      const app = await getService();
      const data = await app.editVideo({ id: req.params.id,
        actor: { id: req.user?._id, role: req.user?.role }, input: req.body });
      res.status(200).json({ data });
    }),
  });
}
