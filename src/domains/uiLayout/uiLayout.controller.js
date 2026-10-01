import asyncHandler from "express-async-handler";
import { uiLayoutService } from "./uiLayout.service.js";
import { createUiBuilderAsset, listUiBuilderAssets } from "./uiLayout.assets.js";
import { getUiLayoutCatalog } from "./uiLayout.catalog.js";
import { uiLayoutReleaseService } from "./uiLayout.release.service.js";

function respond(req, res, data, status = 200, meta = {}) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({ data, meta: { ...meta, request_id: req.requestId } });
}

function actor(req) {
  return { actorId: req.user._id, requestId: req.requestId };
}

export const getCatalog = asyncHandler(async (req, res) => respond(req, res, getUiLayoutCatalog()));

export const uploadAsset = asyncHandler(async (req, res) => {
  const data = await createUiBuilderAsset({ file: req.file, usage: req.body?.usage, actorId: req.user._id });
  respond(req, res, data, 201);
});

export const listAssets = asyncHandler(async (req, res) => {
  respond(req, res, await listUiBuilderAssets(res.locals.uiLayoutInput));
});

export const createDraft = asyncHandler(async (req, res) => {
  const data = await uiLayoutService.createDraft({ ...res.locals.uiLayoutInput, ...actor(req) });
  respond(req, res, data, 201);
});

export const listDrafts = asyncHandler(async (req, res) => {
  respond(req, res, await uiLayoutService.listDrafts(res.locals.uiLayoutInput));
});

export const getDraft = asyncHandler(async (req, res) => {
  respond(req, res, await uiLayoutService.getDraft(res.locals.uiLayoutInput.id));
});

export const saveDraft = asyncHandler(async (req, res) => {
  const data = await uiLayoutService.saveDraft({ ...res.locals.uiLayoutInput, ...actor(req) });
  respond(req, res, data);
});

export const archiveDraft = asyncHandler(async (req, res) => {
  await uiLayoutService.archiveDraft({ ...res.locals.uiLayoutInput, ...actor(req) });
  res.setHeader("Cache-Control", "no-store");
  res.status(204).end();
});

export const validateDraft = asyncHandler(async (req, res) => {
  respond(req, res, await uiLayoutService.validateDraft({ ...res.locals.uiLayoutInput, ...actor(req) }));
});

export const createPreview = asyncHandler(async (req, res) => {
  const data = await uiLayoutService.createPreview({ ...res.locals.uiLayoutInput, ...actor(req) });
  respond(req, res, data, 201);
});

export const getPreview = asyncHandler(async (req, res) => {
  const result = await uiLayoutService.getPreview(req.query.token);
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Pragma", "no-cache");
  res.status(200).json({ data: result.data,
    meta: { ...result.meta, request_id: req.requestId } });
});

export const revokePreview = asyncHandler(async (req, res) => {
  await uiLayoutService.revokePreview({ ...res.locals.uiLayoutInput, ...actor(req) });
  res.setHeader("Cache-Control", "no-store");
  res.status(204).end();
});

export const publishDraft = asyncHandler(async (req, res) => {
  const data = await uiLayoutReleaseService.publishDraft({ ...res.locals.uiLayoutInput, ...actor(req) });
  respond(req, res, data, 201);
});

export const cancelSchedule = asyncHandler(async (req, res) => {
  await uiLayoutService.cancelSchedule({ ...res.locals.uiLayoutInput, ...actor(req) });
  res.setHeader("Cache-Control", "no-store");
  res.status(204).end();
});

export const listHistory = asyncHandler(async (req, res) => {
  respond(req, res, await uiLayoutService.history(res.locals.uiLayoutInput));
});

export const getVersion = asyncHandler(async (req, res) => {
  respond(req, res, await uiLayoutService.getVersion(res.locals.uiLayoutInput.id));
});

export const rollbackVersion = asyncHandler(async (req, res) => {
  const data = await uiLayoutService.rollback({ ...res.locals.uiLayoutInput, ...actor(req) });
  respond(req, res, data, 201);
});

export const getAudit = asyncHandler(async (req, res) => {
  respond(req, res, await uiLayoutService.listAudit(res.locals.uiLayoutInput));
});

export const getPublishedLayout = asyncHandler(async (req, res) => {
  const data = await uiLayoutService.getPublic(res.locals.uiLayoutInput);
  const etag = `"${data.checksum}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
  res.setHeader("Vary", "Authorization, X-App-Platform, X-App-Version, X-App-Locale, X-Location-Id, X-Country-Code");
  if (req.headers["if-none-match"] === etag) return res.status(304).end();
  return res.status(200).json({
    data, meta: { cache_ttl_seconds: 0, request_id: req.requestId },
  });
});
