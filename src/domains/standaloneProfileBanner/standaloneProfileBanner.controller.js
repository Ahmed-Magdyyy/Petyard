import asyncHandler from "express-async-handler";
import {
  getStandaloneProfileBannerService,
  createStandaloneProfileBannerService,
  updateStandaloneProfileBannerService,
} from "./standaloneProfileBanner.service.js";

export const getStandaloneProfileBanner = asyncHandler(async (req, res) => {
  const banner = await getStandaloneProfileBannerService();
  res.status(200).json({ data: banner });
});

export const createStandaloneProfileBanner = asyncHandler(async (req, res) => {
  const banner = await createStandaloneProfileBannerService(req.file);
  res.status(201).json({ data: banner });
});

export const updateStandaloneProfileBanner = asyncHandler(async (req, res) => {
  const banner = await updateStandaloneProfileBannerService(req.file);
  res.status(200).json({ data: banner });
});
