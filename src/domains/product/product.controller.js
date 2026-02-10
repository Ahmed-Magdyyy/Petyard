import asyncHandler from "express-async-handler";

import {
  getProductsService,
  getProductByIdService,
  createProductService,
  updateProductService,
  deleteProductService,
} from "./product.service.js";

export const getProducts = asyncHandler(async (req, res) => {
  const result = await getProductsService(req.query, req.lang);

  res.status(200).json(result);
});

export const getProductsForAdmin = asyncHandler(async (req, res) => {
  const result = await getProductsService(req.query, req.lang, {
    includeZeroStockInWarehouse: true,
  });

  res.status(200).json(result);
});

export const getProduct = asyncHandler(async (req, res) => {
  const data = await getProductByIdService(req.params.id, req.lang, req.user || null);

  res.status(200).json({ data });
});

export const createProduct = asyncHandler(async (req, res) => {
  console.log("req.body:", req.body);
  console.log("req.files:", req.files);

  const product = await createProductService(req.body, req.files || []);

  res.status(201).json({ data: product });
});

export const updateProduct = asyncHandler(async (req, res) => {
  const updated = await updateProductService(
    req.params.id,
    req.body,
    req.files || [],
  );

  res.status(200).json({ data: updated });
});

export const deleteProduct = asyncHandler(async (req, res) => {
  await deleteProductService(req.params.id);

  res.status(200).json({ message: "Product deleted successfully" });
});
