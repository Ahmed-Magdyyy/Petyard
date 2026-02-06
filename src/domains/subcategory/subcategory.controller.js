import asyncHandler from "express-async-handler";
import {
  getSubcategoriesService,
  getSubcategoryByIdService,
  createSubcategoryService,
  updateSubcategoryService,
  deleteSubcategoryService,
} from "./subcategory.service.js";

// GET /subcategories
export const getSubcategories = asyncHandler(async (req, res) => {
  const data = await getSubcategoriesService(req.query, req.lang, req.user || null);
  res.status(200).json({ data });
});

// GET /subcategories/:id
export const getSubcategory = asyncHandler(async (req, res) => {
  const data = await getSubcategoryByIdService(req.params.id, req.lang, req.user || null);
  res.status(200).json({ data });
});

// POST /subcategories
export const createSubcategory = asyncHandler(async (req, res) => {
  const subcategory = await createSubcategoryService(req.body, req.file || null);
  res.status(201).json({ data: subcategory });
});

// PATCH /subcategories/:id
export const updateSubcategory = asyncHandler(async (req, res) => {
  const updated = await updateSubcategoryService(
    req.params.id,
    req.body,
    req.file || null
  );
  res.status(200).json({ data: updated });
});

// DELETE /subcategories/:id
export const deleteSubcategory = asyncHandler(async (req, res) => {
  await deleteSubcategoryService(req.params.id);
  res.status(200).json({ message: "Subcategory deleted successfully" });
});
