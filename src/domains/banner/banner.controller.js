import asyncHandler from "express-async-handler";
import {
  getActiveBannersService,
  getAllBannersService,
  createBannerService,
  updateBannerService,
  deleteBannerService,
} from "./banner.service.js";

export const getActiveBanners = asyncHandler(async (req, res) => {
  const banners = await getActiveBannersService();
  res.status(200).json({ data: banners });
});

export const getAllBanners = asyncHandler(async (req, res) => {
  const banners = await getAllBannersService();
  res.status(200).json({ data: banners });
});

export const createBanner = asyncHandler(async (req, res) => {
  const banner = await createBannerService(req.body, req.file || null);
  res.status(201).json({ data: banner });
});

export const updateBanner = asyncHandler(async (req, res) => {
  const banner = await updateBannerService(
    req.params.id,
    req.body,
    req.file || null
  );
  res.status(200).json({ data: banner });
});

export const deleteBanner = asyncHandler(async (req, res) => {
  await deleteBannerService(req.params.id);
  res.status(200).json({ message: "Banner deleted successfully" });
});
