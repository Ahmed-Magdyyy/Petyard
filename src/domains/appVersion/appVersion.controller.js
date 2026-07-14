import asyncHandler from "express-async-handler";
import {
  checkAppVersionService,
  createAppVersionReleasesService,
  getAppVersionsService,
  listAppVersionReleasesService,
  updateAppVersionPolicyService,
  updateAppVersionReleaseService,
} from "./appVersion.service.js";

export const getAppVersions = asyncHandler(async (req, res) => {
  const appVersions = await getAppVersionsService();
  res.status(200).json(appVersions);
});

export const checkAppVersion = asyncHandler(async (req, res) => {
  const result = await checkAppVersionService({
    platform: req.params.platform || req.query.platform,
    appVersion: req.query.appVersion,
  });

  res.status(200).json(result);
});

export const listAppVersionReleases = asyncHandler(async (req, res) => {
  const result = await listAppVersionReleasesService(req.params.platform);
  res.status(200).json(result);
});

export const createAppVersionReleases = asyncHandler(async (req, res) => {
  const result = await createAppVersionReleasesService({
    payload: req.body,
    actorId: req.user?._id,
  });

  res.status(201).json(result);
});

export const updateAppVersionRelease = asyncHandler(async (req, res) => {
  const result = await updateAppVersionReleaseService({
    platform: req.params.platform,
    version: req.params.version,
    payload: req.body,
    actorId: req.user?._id,
  });

  res.status(200).json(result);
});

export const updateAppVersionPolicy = asyncHandler(async (req, res) => {
  const result = await updateAppVersionPolicyService({
    platform: req.params.platform,
    payload: req.body,
    actorId: req.user?._id,
  });

  res.status(200).json(result);
});
