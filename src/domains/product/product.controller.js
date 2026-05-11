import asyncHandler from "express-async-handler";
import { ApiError } from "../../shared/utils/ApiError.js";

import {
  getProductsService,
  getProductByIdService,
  createProductService,
  updateProductService,
  updateProductStockService,
  deleteProductService,
  searchProductsService,
} from "./product.service.js";

export const getProducts = asyncHandler(async (req, res) => {
  const userId = req.user?._id || null;
  const result = await getProductsService(req.query, req.lang, {}, userId);

  res.status(200).json(result);
});

export const getProductsForAdmin = asyncHandler(async (req, res) => {
  // Moderators: enforce warehouse scope as a server-side safety net.
  // The FE already sends ?warehouse=X, but we validate it here and
  // force-inject a default if missing to prevent unscoped access.
  const scope = req.productWarehouseScope;

  if (Array.isArray(scope)) {
    if (scope.length === 0) {
      return res.status(200).json({
        totalResults: 0,
        totalPages: 1,
        page: 1,
        results: 0,
        data: [],
      });
    }

    const requestedWarehouse = req.query.warehouse;

    if (requestedWarehouse) {
      // Validate the requested warehouse is within the moderator's scope
      const allowed = scope.some(
        (w) => String(w) === String(requestedWarehouse),
      );
      if (!allowed) {
        throw new ApiError("You are not allowed to access this route", 403);
      }
    } else {
      // No warehouse specified — default to the moderator's first warehouse
      req.query.warehouse = String(scope[0]);
    }
  }

  const result = await getProductsService(req.query, req.lang, {
    includeZeroStockInWarehouse: true,
  });

  res.status(200).json(result);
});

export const getProduct = asyncHandler(async (req, res) => {
  const data = await getProductByIdService(
    req.params.id,
    req.lang,
    req.user || null,
    req.query.warehouse || null,
  );

  res.status(200).json({ data });
});

export const createProduct = asyncHandler(async (req, res) => {
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

export const updateProductStock = asyncHandler(async (req, res) => {
  const updated = await updateProductStockService(
    req.params.id,
    req.body,
    req.productWarehouseScope,
  );

  res.status(200).json({ data: updated });
});

export const deleteProduct = asyncHandler(async (req, res) => {
  await deleteProductService(req.params.id);

  res.status(200).json({ message: "Product deleted successfully" });
});

export const searchProducts = asyncHandler(async (req, res) => {
  const userId = req.user?._id || null;
  const { q, warehouse, limit } = req.query;

  const result = await searchProductsService({
    q,
    warehouse,
    limit,
    lang: req.lang,
    userId,
  });

  res.status(200).json(result);
});
