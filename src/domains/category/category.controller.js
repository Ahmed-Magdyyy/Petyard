import asyncHandler from "express-async-handler";
import {
  getCategoriesService,
  getCategoryByIdService,
  createCategoryService,
  updateCategoryService,
  deleteCategoryService,
} from "./category.service.js";

// GET /categories
export const getCategories = asyncHandler(async (req, res) => {
  const data = await getCategoriesService(req.lang, req.user || null);
  res.status(200).json({ data });
});

// GET /categories/:id
export const getCategory = asyncHandler(async (req, res) => {
  const data = await getCategoryByIdService(req.params.id, req.lang, req.user || null);
  res.status(200).json({ data });
});

// POST /categories
export const createCategory = asyncHandler(async (req, res) => {
  const category = await createCategoryService(req.body, req.file || null);
  res.status(201).json({ data: category });
});

// PATCH /categories/:id
export const updateCategory = asyncHandler(async (req, res) => {
  const updated = await updateCategoryService(req.params.id, req.body, req.file || null);
  res.status(200).json({ data: updated });
});

// DELETE /categories/:id
export const deleteCategory = asyncHandler(async (req, res) => {
  await deleteCategoryService(req.params.id);
  res.status(200).json({ message: "Category deleted successfully" });
});
