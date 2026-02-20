import { ApiError } from "../../shared/utils/ApiError.js";
import { ProductModel } from "../product/product.model.js";
import { CollectionModel } from "./collection.model.js";

function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

function toDateOrThrow(value, fieldName) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (!isValidDate(d)) {
    throw new ApiError(`${fieldName} must be a valid date`, 400);
  }
  return d;
}

export function isPromotionActiveNow(promotion, now = new Date()) {
  if (!promotion || promotion.enabled !== true || promotion.isActive !== true) {
    return false;
  }

  const startsAt = promotion.startsAt ? new Date(promotion.startsAt) : null;
  const endsAt = promotion.endsAt ? new Date(promotion.endsAt) : null;

  if (!startsAt || !endsAt) return false;
  if (!isValidDate(startsAt) || !isValidDate(endsAt)) return false;

  return startsAt <= now && now < endsAt;
}

export async function autoHideExpiredCollections() {
  const now = new Date();

  await CollectionModel.updateMany(
    {
      isVisible: true,
      "promotion.enabled": true,
      "promotion.endsAt": { $lte: now },
    },
    { $set: { isVisible: false } }
  );
}

export async function resolveProductIdsForSelector(selector) {
  const ids = new Set();

  const productIds = Array.isArray(selector?.productIds) ? selector.productIds : [];
  const subcategoryIds = Array.isArray(selector?.subcategoryIds)
    ? selector.subcategoryIds
    : [];
  const brandIds = Array.isArray(selector?.brandIds) ? selector.brandIds : [];

  for (const id of productIds) {
    if (id != null) ids.add(String(id));
  }

  if (subcategoryIds.length > 0) {
    const products = await ProductModel.find(
      { subcategory: { $in: subcategoryIds } },
      { _id: 1 }
    ).lean();

    for (const p of products) {
      ids.add(String(p._id));
    }
  }

  if (brandIds.length > 0) {
    const products = await ProductModel.find(
      { brand: { $in: brandIds } },
      { _id: 1 }
    ).lean();

    for (const p of products) {
      ids.add(String(p._id));
    }
  }

  return Array.from(ids);
}

export async function ensurePromotionalCollectionUniqueness({
  collectionId,
  selector,
  promotion,
}) {
  if (!promotion || promotion.enabled !== true || promotion.isActive !== true) {
    return;
  }

  const startsAt = toDateOrThrow(promotion.startsAt, "promotion.startsAt");
  const endsAt = toDateOrThrow(promotion.endsAt, "promotion.endsAt");

  if (!startsAt || !endsAt) {
    throw new ApiError("promotion.startsAt and promotion.endsAt are required", 400);
  }

  if (endsAt <= startsAt) {
    throw new ApiError("promotion.endsAt must be after promotion.startsAt", 400);
  }

  const productIds = await resolveProductIdsForSelector(selector);
  if (productIds.length === 0) {
    throw new ApiError(
      "Promotional collection selector must resolve to at least one product",
      400
    );
  }

  const filter = {
    ...(collectionId && { _id: { $ne: collectionId } }),
    isVisible: true,
    "promotion.enabled": true,
    "promotion.isActive": true,
    "promotion.startsAt": { $lt: endsAt },
    "promotion.endsAt": { $gt: startsAt },
  };

  const otherCollections = await CollectionModel.find(filter, {
    selector: 1,
    slug: 1,
  }).lean();

  if (otherCollections.length === 0) return;

  const productIdSet = new Set(productIds);
  const conflicts = [];

  for (const other of otherCollections) {
    const otherProductIds = await resolveProductIdsForSelector(other.selector);
    const overlapping = otherProductIds.filter((pid) => productIdSet.has(String(pid)));

    if (overlapping.length > 0) {
      conflicts.push({
        collectionId: other._id,
        collectionSlug: other.slug,
        conflictingProductIds: overlapping,
      });
    }
  }

  if (conflicts.length > 0) {
    const allProductIds = [...new Set(conflicts.flatMap((c) => c.conflictingProductIds))];
    const collectionSlugs = conflicts.map((c) => c.collectionSlug);

    // Fetch product names in a single query
    const products = await ProductModel.find(
      { _id: { $in: allProductIds } },
      { name_en: 1 }
    ).lean();
    const nameMap = new Map(products.map((p) => [String(p._id), p.name_en]));

    const enrichedConflicts = conflicts.map((c) => ({
      collectionSlug: c.collectionSlug,
      conflictingProducts: c.conflictingProductIds.map((id) => nameMap.get(String(id)) || String(id)),
    }));

    const err = new ApiError(
      `${allProductIds.length} product(s) already belong to another promotional collection with overlapping dates. Conflicting collection(s): ${collectionSlugs.join(", ")}.`,
      409
    );
    err.errors = enrichedConflicts;
    throw err;
  }
}

export async function findActivePromotionForProduct(
  { productId, subcategoryId, brandId },
  now = new Date()
) {
  const or = [];

  if (productId) {
    or.push({ "selector.productIds": productId });
  }

  if (subcategoryId) {
    or.push({ "selector.subcategoryIds": subcategoryId });
  }

  if (brandId) {
    or.push({ "selector.brandIds": brandId });
  }

  if (or.length === 0) return null;

  const collection = await CollectionModel.findOne(
    {
      isVisible: true,
      "promotion.enabled": true,
      "promotion.isActive": true,
      "promotion.startsAt": { $lte: now },
      "promotion.endsAt": { $gt: now },
      $or: or,
    },
    {
      _id: 1,
      slug: 1,
      promotion: 1,
    }
  ).lean();

  if (!collection?.promotion) return null;

  return {
    collectionId: collection._id,
    collectionSlug: collection.slug,
    discountPercent:
      typeof collection.promotion.discountPercent === "number"
        ? collection.promotion.discountPercent
        : null,
  };
}

export async function findActivePromotionsForProducts(products = [], now = new Date()) {
  const list = Array.isArray(products) ? products : [];
  if (list.length === 0) return new Map();

  const productIds = [];
  const subcategoryIds = [];
  const brandIds = [];

  for (const p of list) {
    if (p?._id) {
      productIds.push(p._id);
    }
    const subId = p?.subcategory?._id || p?.subcategory;
    if (subId) {
      subcategoryIds.push(subId);
    }
    const brandId = p?.brand?._id || p?.brand;
    if (brandId) {
      brandIds.push(brandId);
    }
  }

  const or = [];
  if (productIds.length > 0) {
    or.push({ "selector.productIds": { $in: productIds } });
  }
  if (subcategoryIds.length > 0) {
    or.push({ "selector.subcategoryIds": { $in: subcategoryIds } });
  }
  if (brandIds.length > 0) {
    or.push({ "selector.brandIds": { $in: brandIds } });
  }

  if (or.length === 0) return new Map();

  const collections = await CollectionModel.find(
    {
      isVisible: true,
      "promotion.enabled": true,
      "promotion.isActive": true,
      "promotion.startsAt": { $lte: now },
      "promotion.endsAt": { $gt: now },
      $or: or,
    },
    {
      _id: 1,
      slug: 1,
      promotion: 1,
      selector: 1,
    }
  ).lean();

  if (!Array.isArray(collections) || collections.length === 0) {
    return new Map();
  }

  const promoByProductId = new Map();
  const promoBySubcategoryId = new Map();
  const promoByBrandId = new Map();

  for (const c of collections) {
    if (!c?.promotion) continue;

    const promo = {
      collectionId: c._id,
      collectionSlug: c.slug,
      discountPercent:
        typeof c.promotion.discountPercent === "number"
          ? c.promotion.discountPercent
          : null,
    };

    const selectorProductIds = Array.isArray(c.selector?.productIds)
      ? c.selector.productIds
      : [];
    const selectorSubcategoryIds = Array.isArray(c.selector?.subcategoryIds)
      ? c.selector.subcategoryIds
      : [];
    const selectorBrandIds = Array.isArray(c.selector?.brandIds)
      ? c.selector.brandIds
      : [];

    for (const id of selectorProductIds) {
      const key = id != null ? String(id) : "";
      if (key && !promoByProductId.has(key)) {
        promoByProductId.set(key, promo);
      }
    }

    for (const id of selectorSubcategoryIds) {
      const key = id != null ? String(id) : "";
      if (key && !promoBySubcategoryId.has(key)) {
        promoBySubcategoryId.set(key, promo);
      }
    }

    for (const id of selectorBrandIds) {
      const key = id != null ? String(id) : "";
      if (key && !promoByBrandId.has(key)) {
        promoByBrandId.set(key, promo);
      }
    }
  }

  const result = new Map();
  for (const p of list) {
    const pid = p?._id != null ? String(p._id) : "";
    if (!pid) continue;

    const direct = promoByProductId.get(pid);
    if (direct) {
      result.set(pid, direct);
      continue;
    }

    const subId = p?.subcategory?._id || p?.subcategory;
    const subPromo = subId != null ? promoBySubcategoryId.get(String(subId)) : null;
    if (subPromo) {
      result.set(pid, subPromo);
      continue;
    }

    const brandId = p?.brand?._id || p?.brand;
    const brandPromo = brandId != null ? promoByBrandId.get(String(brandId)) : null;
    if (brandPromo) {
      result.set(pid, brandPromo);
    }
  }

  return result;
}
