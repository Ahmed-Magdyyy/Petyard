import asyncHandler from "express-async-handler";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  enabledControls,
  roles,
} from "../../shared/constants/enums.js";

import {
  getProductsService,
  getProductByIdService,
  createProductService,
  updateProductService,
  updateProductStockService,
  deleteProductService,
  searchProductsService,
} from "./product.service.js";
import {
  commitProductSearchService,
  getPopularProductSearchesService,
  getProductSearchHistoryService,
  removeProductSearchHistoryTermService,
} from "./productSearchHistory.service.js";

function getGuestId(req) {
  const headerValue = req.headers["x-guest-id"];
  return typeof headerValue === "string" && headerValue.trim()
    ? headerValue.trim()
    : null;
}

export const getProducts = asyncHandler(async (req, res) => {
  const userId = req.user?._id || null;
  const guestId = userId ? null : getGuestId(req);
  const result = await getProductsService(
    req.query,
    req.lang,
    {
      onlyActive: true,
      hideOutOfStock: true,
    },
    userId,
    guestId,
  );

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

function getStaffStockRevisionAccess(req) {
  const user = req.user;
  if (!user) return { allowed: false, warehouseScope: null };

  const hasProductControl =
    user.role === roles.SUPER_ADMIN ||
    ((user.role === roles.ADMIN || user.role === roles.MODERATOR) &&
      user.enabledControls?.includes(enabledControls.PRODUCTS));
  if (!hasProductControl) {
    return { allowed: false, warehouseScope: null };
  }

  const warehouseScope =
    user.role === roles.MODERATOR ? req.productWarehouseScope : null;
  if (Array.isArray(warehouseScope) && warehouseScope.length === 0) {
    throw new ApiError("You are not assigned to any warehouse", 403);
  }

  const requestedWarehouse = req.query.warehouse;
  if (
    requestedWarehouse &&
    Array.isArray(warehouseScope) &&
    !warehouseScope.some(
      (warehouse) => String(warehouse) === String(requestedWarehouse),
    )
  ) {
    throw new ApiError("You are not allowed to access this route", 403);
  }

  return { allowed: true, warehouseScope };
}

export const getProduct = asyncHandler(async (req, res) => {
  const guestId = req.user ? null : getGuestId(req);
  const revisionAccess = getStaffStockRevisionAccess(req);
  const data = await getProductByIdService(
    req.params.id,
    req.lang,
    req.user || null,
    req.query.warehouse || null,
    guestId,
    {
      includeStockRevisions: revisionAccess.allowed,
      stockRevisionWarehouseScope: revisionAccess.warehouseScope,
    },
  );

  res.status(200).json({ data });
});

export const createProduct = asyncHandler(async (req, res) => {
  const product = await createProductService(req.body, req.files || []);

  res.status(201).json({ data: product });
});

export const updateProduct = asyncHandler(async (req, res) => {
  console.log("updateProduct req.files:", req.files);
  console.log("updateProduct req.body:", JSON.stringify(req.body, null, 2));
  const updated = await updateProductService(
    req.params.id,
    req.body,
    req.files || [],
  );
  console.log("user updated this: " , req.user._id);

  res.status(200).json({ data: updated });
});

export const updateProductStock = asyncHandler(async (req, res) => {
  const updated = await updateProductStockService(
    req.params.id,
    req.body,
    req.productWarehouseScope,
  );
  console.log("user updated this: " , req.user._id);

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

export const searchProductsForAdmin = asyncHandler(async (req, res) => {
  const scope = req.productWarehouseScope;

  if (Array.isArray(scope)) {
    if (scope.length === 0) {
      return res.status(200).json({ suggestions: [], products: [] });
    }

    const requestedWarehouse = req.query.warehouse;

    if (requestedWarehouse) {
      const allowed = scope.some(
        (w) => String(w) === String(requestedWarehouse),
      );
      if (!allowed) {
        throw new ApiError("You are not allowed to access this route", 403);
      }
    } else {
      req.query.warehouse = String(scope[0]);
    }
  }

  const { q, warehouse, limit } = req.query;

  const result = await searchProductsService({
    q,
    warehouse,
    limit,
    lang: req.lang,
    includeZeroStock: true,
  });

  res.status(200).json(result);
});

export const commitProductSearch = asyncHandler(async (req, res) => {
  const data = await commitProductSearchService({
    userId: req.user?._id,
    guestId: req.guestId,
    q: req.body.q,
  });

  res.status(200).json({ data });
});

export const getProductSearchHistory = asyncHandler(async (req, res) => {
  const data = await getProductSearchHistoryService({
    userId: req.user?._id,
    guestId: req.guestId,
  });

  res.status(200).json({ data });
});

export const removeProductSearchHistoryTerm = asyncHandler(async (req, res) => {
  const data = await removeProductSearchHistoryTermService({
    userId: req.user?._id,
    guestId: req.guestId,
    q: req.body.q,
  });

  res.status(200).json({ data });
});

export const getPopularProductSearches = asyncHandler(async (req, res) => {
  const data = await getPopularProductSearchesService({
    limit: req.query.limit === undefined ? 10 : Number(req.query.limit),
  });

  res.status(200).json({ data });
});
