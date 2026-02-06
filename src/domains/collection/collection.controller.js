import asyncHandler from "express-async-handler";
import {
  getCollectionsService,
  getCollectionByIdService,
  getCollectionWithProductsService,
  createCollectionService,
  updateCollectionService,
  deleteCollectionService,
} from "./collection.service.js";

export const getCollections = asyncHandler(async (req, res) => {
  const data = await getCollectionsService(req.lang);
  res.status(200).json({ data });
});

export const getCollection = asyncHandler(async (req, res) => {
  const data = await getCollectionByIdService(req.params.id, req.lang);
  res.status(200).json({ data });
});

export const getCollectionWithProducts = asyncHandler(async (req, res) => {
  const data = await getCollectionWithProductsService(
    req.params.id,
    req.query,
    req.lang
  );
  res.status(200).json({ data });
});

export const createCollection = asyncHandler(async (req, res) => {
  const collection = await createCollectionService(req.body, req.file || null);
  res.status(201).json({ data: collection });
});

export const updateCollection = asyncHandler(async (req, res) => {
  const updated = await updateCollectionService(
    req.params.id,
    req.body,
    req.file || null
  );
  res.status(200).json({ data: updated });
});

export const deleteCollection = asyncHandler(async (req, res) => {
  await deleteCollectionService(req.params.id);
  res.status(200).json({ message: "Collection deleted successfully" });
});
