import asyncHandler from "express-async-handler";
import { roles, productTypeEnum } from "../../shared/constants/enums.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { findProductById } from "./product.repository.js";
import { ApiError } from "../../shared/utils/ApiError.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Safely parse a value that might be a JSON string (multipart form)
 * or already a parsed array (JSON body).
 */
function ensureArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Merges a moderator's stock changes into an existing warehouseStocks array.
 * Only entries whose warehouse is in `allowedSet` are updated or added;
 * all other warehouse entries are preserved untouched.
 *
 * @param {Array} existingStocks - Current warehouseStocks from the DB product
 * @param {Array} incomingStocks - Moderator's submitted stock changes
 * @param {Set<string>} allowedSet - Set of warehouse IDs the moderator owns
 * @returns {Array} Complete merged warehouseStocks array
 */
function mergeWarehouseStocks(existingStocks, incomingStocks, allowedSet) {
  // Start with a deep clone of existing stocks
  const merged = (existingStocks || []).map((ws) => ({
    warehouse: ws.warehouse,
    quantity: ws.quantity,
  }));

  const incoming = ensureArray(incomingStocks);

  for (const entry of incoming) {
    if (!entry?.warehouse) continue;

    const warehouseId = String(entry.warehouse);

    // Silently skip warehouses the moderator is not assigned to
    if (!allowedSet.has(warehouseId)) continue;

    const quantity =
      typeof entry.quantity === "number"
        ? entry.quantity
        : Number(entry.quantity) || 0;

    const idx = merged.findIndex((ws) => String(ws.warehouse) === warehouseId);

    if (idx >= 0) {
      merged[idx].quantity = quantity;
    } else {
      merged.push({ warehouse: entry.warehouse, quantity });
    }
  }

  return merged;
}

/**
 * Rebuilds the full variants array, preserving every existing variant's fields
 * (price, options, sku, images, etc.) and only merging the moderator's
 * warehouseStocks changes for their allowed warehouses.
 *
 * Incoming variants are matched to existing ones by `_id`.
 *
 * @param {Array} existingVariants - Current variants from the DB product
 * @param {Array} incomingVariants - Moderator's submitted variant changes
 * @param {Set<string>} allowedSet  - Set of warehouse IDs the moderator owns
 * @returns {Array} Complete rebuilt variants array
 */
function mergeVariantsStock(existingVariants, incomingVariants, allowedSet) {
  // Build a lookup of incoming changes keyed by variant _id
  const incomingMap = new Map();
  for (const v of ensureArray(incomingVariants)) {
    if (v?._id) {
      incomingMap.set(String(v._id), v);
    }
  }

  return (existingVariants || []).map((variant) => {
    const incoming = incomingMap.get(String(variant._id));

    return {
      _id: variant._id,
      sku: variant.sku,
      price: variant.price,
      discountedPrice: variant.discountedPrice,
      options: variant.options || [],
      isDefault: variant.isDefault,
      images: variant.images || [],
      warehouseStocks: mergeWarehouseStocks(
        variant.warehouseStocks || [],
        incoming?.warehouseStocks || [],
        allowedSet,
      ),
    };
  });
}

// ─── Middlewares ──────────────────────────────────────────────────────────────

/**
 * Resolves the warehouse IDs a moderator is assigned to and attaches them
 * to `req.productWarehouseScope`.
 *
 * - Moderators  → array of ObjectIds (may be empty)
 * - Non-moderators → null (no restriction)
 *
 * Mirrors `scopeOrdersToModeratorWarehouses` from the order domain.
 */
export const scopeProductsToModeratorWarehouses = asyncHandler(
  async (req, res, next) => {
    if (!req.user || req.user.role !== roles.MODERATOR) {
      req.productWarehouseScope = null;
      return next();
    }

    const warehouses = await WarehouseModel.find({ moderators: req.user._id })
      .select("_id")
      .lean();

    req.productWarehouseScope = warehouses.map((w) => w._id);
    next();
  },
);

/**
 * For moderators, sanitises `req.body` so they can ONLY update warehouse
 * stock quantities for their assigned warehouse(s).
 *
 * How it works:
 *  1. Fetches the current product from the DB.
 *  2. Merges the moderator's stock changes into the full warehouseStocks
 *     array (SIMPLE) or per-variant warehouseStocks (VARIANT).
 *  3. Replaces `req.body` with the sanitised payload — all other fields
 *     (price, name, images, etc.) are stripped.
 *  4. Clears `req.files` to prevent image uploads.
 *
 * Admins / super-admins bypass this middleware entirely.
 */
export const restrictModeratorProductUpdate = asyncHandler(
  async (req, res, next) => {
    if (!req.user || req.user.role !== roles.MODERATOR) {
      return next();
    }

    const allowedIds = req.productWarehouseScope;
    if (!Array.isArray(allowedIds) || allowedIds.length === 0) {
      throw new ApiError("You are not assigned to any warehouse", 403);
    }

    const product = await findProductById(req.params.id);
    if (!product) {
      throw new ApiError(
        `No product found for this id: ${req.params.id}`,
        404,
      );
    }

    const allowedSet = new Set(allowedIds.map(String));
    const sanitised = {};

    if (product.type === productTypeEnum.SIMPLE) {
      sanitised.warehouseStocks = mergeWarehouseStocks(
        product.warehouseStocks,
        req.body.warehouseStocks,
        allowedSet,
      );
    } else if (product.type === productTypeEnum.VARIANT) {
      sanitised.variants = mergeVariantsStock(
        product.variants,
        req.body.variants,
        allowedSet,
      );
    }

    req.body = sanitised;
    req.files = [];
    next();
  },
);
