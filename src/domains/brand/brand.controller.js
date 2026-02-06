import asyncHandler from "express-async-handler";
import {
  getBrandsService,
  getBrandByIdService,
  createBrandService,
  updateBrandService,
  deleteBrandService,
} from "./brand.service.js";

// GET /brands
export const getBrands = asyncHandler(async (req, res) => {
  const data = await getBrandsService(req.lang, req.user || null);
  res.status(200).json({ data });
});

// GET /brands/:id
export const getBrand = asyncHandler(async (req, res) => {
  const data = await getBrandByIdService(req.params.id, req.lang, req.user || null);
  res.status(200).json({ data });
});

// POST /brands
export const createBrand = asyncHandler(async (req, res) => {
  const brand = await createBrandService(req.body, req.file || null);
  res.status(201).json({ data: brand });
});

// PATCH /brands/:id
export const updateBrand = asyncHandler(async (req, res) => {
  const updated = await updateBrandService(req.params.id, req.body, req.file || null);
  res.status(200).json({ data: updated });
});

// DELETE /brands/:id
export const deleteBrand = asyncHandler(async (req, res) => {
  await deleteBrandService(req.params.id);
  res.status(204).json({ message: "Brand deleted successfully" });
});
