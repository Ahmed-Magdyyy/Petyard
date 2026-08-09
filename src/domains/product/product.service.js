import {
  countProducts,
  findProducts,
  findProductIds,
  findProductById,
  findProductByIdWithRefs,
  findProductBySlug,
  createProduct,
  deleteProductById,
} from "./product.repository.js";
import { findCollectionById } from "../collection/collection.repository.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  normalizeTag,
  normalizeTagsInput,
} from "../../shared/utils/tagging.js";
import {
  generateProductTags,
  mergeTagsWithAI,
} from "../../shared/utils/aiTagging.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import { getSubcategoryChildrenIds } from "../subcategory/subcategory.service.js";
import { normalizeProductType } from "../../shared/utils/productType.js";
import {
  productTypeEnum,
  roles,
  enabledControls,
  orderStatusEnum,
} from "../../shared/constants/enums.js";
import {
  buildPagination,
  buildSort,
  buildRegexFilter,
} from "../../shared/utils/apiFeatures.js";
import {
  validateImageFile,
  uploadImage,
  deleteImage,
  IMAGE_UPLOAD_PROFILES,
  IMAGE_VISIBILITY,
} from "../../shared/utils/imageUpload.js";
import { getOrSetCache, stableStringify } from "../../shared/utils/cache.js";
import { buildFlexibleSearchPattern } from "../../shared/utils/escapeRegex.js";
import { computeFinalDiscountedPrice } from "../../shared/utils/pricing.js";
import {
  getProductListCacheVersion,
  invalidateProductCaches,
  productCacheConfig,
} from "./productCache.service.js";
import {
  autoHideExpiredCollections,
  findActivePromotionForProduct,
  findActivePromotionsForProducts,
} from "../collection/collection.promotion.js";
import { brandExists } from "../brand/brand.repository.js";
import { BrandModel } from "../brand/brand.model.js";
import { findSubcategoryById } from "../subcategory/subcategory.repository.js";
import { CategoryModel } from "../category/category.model.js";
import {
  countWarehouses,
  findWarehouseIds,
} from "../warehouse/warehouse.repository.js";
import { FavoriteModel } from "../favorite/favorite.model.js";
import { OrderModel } from "../order/order.model.js";
import { queueProductForSubcategoryDigest } from "../subcategorySubscription/subcategoryProductDigest.service.js";
import {
  cleanupRestockSubscriptionsForProduct,
  getMyRestockSubscriptionsService,
  getRestockSubscribedProductIdsForUser,
  getRestockSubscriptionStatusService,
  processRestockSubscriptionsForProduct,
} from "../restockSubscription/restockSubscription.service.js";
import { completeWarehouseStocks } from "./productWarehouseStocks.js";

import { resolveEffectiveWarehouse } from '../warehouse/warehouse.fulfillment.js';

const PRODUCT_CARD_SELECT =
  "_id slug type isActive name_en name_ar tags price discountedPrice images warehouseStocks.warehouse warehouseStocks.quantity variants.price variants.discountedPrice variants.warehouseStocks.warehouse variants.warehouseStocks.quantity ratingAverage ratingCount category subcategory brand";

function processRestockSubscriptionsBestEffort(productId, warehouseIds) {
  processRestockSubscriptionsForProduct({ productId, warehouseIds }).catch(
    (error) =>
      console.error(
        "[Product] Failed to process restock subscriptions:",
        error?.message || error,
      ),
  );
}

async function getUserFavoriteProductIds(userId) {
  if (!userId) return new Set();
  const fav = await FavoriteModel.findOne({ user: userId })
    .select("items.product")
    .lean();
  if (!fav || !Array.isArray(fav.items)) return new Set();
  return new Set(fav.items.map((item) => String(item.product)));
}

async function getFavoriteProductIdsForIdentity({ userId, guestId }) {
  if (userId) return getUserFavoriteProductIds(userId);
  if (!guestId) return new Set();

  const favorite = await FavoriteModel.findOne({ guestId })
    .select("items.product")
    .lean();
  if (!favorite || !Array.isArray(favorite.items)) return new Set();
  return new Set(favorite.items.map((item) => String(item.product)));
}

export {
  getProductsService,
  getMyRestockSubscribedProductsService,
  getProductByIdService,
  createProductService,
  updateProductService,
  updateProductStockService,
  deleteProductService,
  mapProductToCardDto,
};

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
}

function normalizeTags(tags) {
  return normalizeTagsInput(tags);
}

function parseProductPriceBound(value, fieldName) {
  if (value === undefined) return undefined;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ApiError(`${fieldName} must be a non-negative number`, 400);
  }

  return parsed;
}

/**
 * `removedImagePublicIds` is an opt-in signal for the merge image-update
 * contract. Older clients omit it and retain the legacy replacement behavior.
 */
function parseRemovedImagePublicIds(value) {
  if (value === undefined) {
    return { useImageMerge: false, publicIds: [] };
  }

  let rawValue = value;
  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return { useImageMerge: true, publicIds: [] };
    }

    try {
      rawValue = JSON.parse(trimmed);
    } catch {
      throw new ApiError(
        "removedImagePublicIds must be a JSON array of image public IDs",
        400,
      );
    }
  }

  if (!Array.isArray(rawValue)) {
    throw new ApiError(
      "removedImagePublicIds must be an array of image public IDs",
      400,
    );
  }

  const publicIds = rawValue.map((publicId) => {
    if (typeof publicId !== "string" || !publicId.trim()) {
      throw new ApiError(
        "removedImagePublicIds must contain only non-empty strings",
        400,
      );
    }
    return publicId.trim();
  });

  return { useImageMerge: true, publicIds: [...new Set(publicIds)] };
}

function normalizeProductOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((opt) => {
      const name = typeof opt.name === "string" ? opt.name.trim() : "";
      if (!name) return null;

      const values = Array.isArray(opt.values)
        ? opt.values
            .map((v) => (typeof v === "string" ? v.trim() : ""))
            .filter(Boolean)
        : [];

      if (!values.length) return null;

      return { name, values };
    })
    .filter(Boolean);
}

function validateVariantOptionsMatrix(productOptions, rawVariants) {
  const optionDefs = Array.isArray(productOptions) ? productOptions : [];
  const variants = Array.isArray(rawVariants) ? rawVariants : [];

  if (!optionDefs.length) {
    if (variants.length) {
      throw new ApiError(
        "options are required for VARIANT products and must have at least one option with values",
        400,
      );
    }
    return;
  }

  const optionNames = optionDefs.map((o) => o.name);

  variants.forEach((variant, index) => {
    const label = index + 1;

    if (
      !variant ||
      !Array.isArray(variant.options) ||
      variant.options.length === 0
    ) {
      throw new ApiError(
        `Variant #${label} must define options for all product options: ${optionNames.join(
          ", ",
        )}`,
        400,
      );
    }

    const variantOptionsMap = new Map();

    for (const opt of variant.options) {
      const name = typeof opt?.name === "string" ? opt.name.trim() : "";
      const value = typeof opt?.value === "string" ? opt.value.trim() : "";

      if (!name || !value) {
        throw new ApiError(
          `Variant #${label} has an option with missing name or value. Each option must have both name and value.`,
          400,
        );
      }

      variantOptionsMap.set(name, value);
    }

    const missingNames = optionNames.filter(
      (name) => !variantOptionsMap.has(name),
    );
    const extraNames = [...variantOptionsMap.keys()].filter(
      (name) => !optionNames.includes(name),
    );

    if (missingNames.length || extraNames.length) {
      if (missingNames.length) {
        throw new ApiError(
          `Variant #${label} is missing options: ${missingNames.join(
            ", ",
          )}. Each variant must specify all product options: ${optionNames.join(
            ", ",
          )}`,
          400,
        );
      }

      if (extraNames.length) {
        throw new ApiError(
          `Variant #${label} has unknown options: ${extraNames.join(
            ", ",
          )}. Valid option names are: ${optionNames.join(", ")}`,
          400,
        );
      }
    }

    for (const optDef of optionDefs) {
      const value = variantOptionsMap.get(optDef.name);
      if (!optDef.values.includes(value)) {
        throw new ApiError(
          `Variant #${label} has invalid value '${value}' for option '${
            optDef.name
          }'. Allowed values: ${optDef.values.join(", ")}`,
          400,
        );
      }
    }
  });
}

function computeTotalStockForSimple(product) {
  if (!Array.isArray(product.warehouseStocks)) return 0;
  return product.warehouseStocks.reduce(
    (sum, ws) => sum + (typeof ws.quantity === "number" ? ws.quantity : 0),
    0,
  );
}

function computeTotalStockForVariants(product) {
  if (!Array.isArray(product.variants)) return 0;
  return product.variants.reduce((total, variant) => {
    if (!Array.isArray(variant.warehouseStocks)) return total;
    const variantStock = variant.warehouseStocks.reduce(
      (sum, ws) => sum + (typeof ws.quantity === "number" ? ws.quantity : 0),
      0,
    );
    return total + variantStock;
  }, 0);
}

function pickMainImage(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  const main = images.find((img) => img.isMain) || images[0];
  return main || null;
}

function mapProductSortKey(sortKey) {
  if (!sortKey) return null;

  switch (String(sortKey)) {
    case "featured":
      return { isFeatured: -1, createdAt: -1 };
    case "alpha_asc":
      return { name_en: 1 };
    case "alpha_desc":
      return { name_en: -1 };
    case "price_asc":
      return { price: 1 };
    case "price_desc":
      return { price: -1 };
    case "date_asc":
      return { createdAt: 1 };
    case "date_desc":
      return { createdAt: -1 };
    default:
      return null;
  }
}

function isBestSellerSort(sortKey) {
  return String(sortKey || "") === "best_seller";
}

async function findBestSellingProducts({
  mongoFilter,
  skip,
  limit,
  select,
  fallbackSort,
}) {
  const excludedOrderStatuses = [
    orderStatusEnum.CANCELLED,
    orderStatusEnum.RETURNED,
  ];

  // Rank at the product level, combining quantities across all variants.
  const salesRows = await OrderModel.aggregate([
    { $match: { status: { $nin: excludedOrderStatuses } } },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.product",
        totalQuantitySold: { $sum: "$items.quantity" },
      },
    },
    { $sort: { totalQuantitySold: -1, _id: 1 } },
    { $project: { _id: 1 } },
  ]);

  const soldProductIds = salesRows
    .map((row) => row?._id)
    .filter(Boolean);

  if (soldProductIds.length === 0) {
    return findProducts(mongoFilter, {
      skip,
      limit,
      sort: fallbackSort,
      select,
      lean: true,
    });
  }

  // Apply the current catalogue filters (category, active state, warehouse,
  // search text, etc.) before paginating the sales ranking.
  const matchingSoldProducts = await findProductIds({
    $and: [mongoFilter, { _id: { $in: soldProductIds } }],
  });
  const matchingSoldIds = new Set(
    matchingSoldProducts.map((product) => String(product._id)),
  );
  const rankedMatchingSoldIds = soldProductIds.filter((id) =>
    matchingSoldIds.has(String(id)),
  );

  const soldIdsForPage = rankedMatchingSoldIds.slice(skip, skip + limit);
  const unsoldLimit = Math.max(limit - soldIdsForPage.length, 0);
  const unsoldSkip = Math.max(skip - rankedMatchingSoldIds.length, 0);

  const [soldProducts, unsoldProducts] = await Promise.all([
    soldIdsForPage.length > 0
      ? findProducts(
          { _id: { $in: soldIdsForPage } },
          { select, lean: true },
        )
      : Promise.resolve([]),
    unsoldLimit > 0
      ? findProducts(
          {
            $and: [mongoFilter, { _id: { $nin: soldProductIds } }],
          },
          {
            skip: unsoldSkip,
            limit: unsoldLimit,
            sort: fallbackSort,
            select,
            lean: true,
          },
        )
      : Promise.resolve([]),
  ]);

  // MongoDB does not preserve the order of an $in clause, so restore the
  // quantity-sold ordering after fetching the populated product documents.
  const soldProductsById = new Map(
    soldProducts.map((product) => [String(product._id), product]),
  );
  const orderedSoldProducts = soldIdsForPage
    .map((id) => soldProductsById.get(String(id)))
    .filter(Boolean);

  return [...orderedSoldProducts, ...unsoldProducts];
}

let lastAutoHideExpiredCollectionsRunAt = 0;
async function autoHideExpiredCollectionsThrottled(minIntervalMs = 60_000) {
  const now = Date.now();
  if (now - lastAutoHideExpiredCollectionsRunAt < minIntervalMs) return;
  lastAutoHideExpiredCollectionsRunAt = now;
  try {
    await autoHideExpiredCollections();
  } catch (err) {
    // Ignore auto-hide failures to avoid impacting read endpoints
    console.error("[autoHideExpiredCollections] error", err?.message || err);
  }
}

function parseIdFilter(value) {
  if (value == null) return null;

  if (Array.isArray(value)) {
    const ids = value.map((v) => String(v).trim()).filter(Boolean);
    if (!ids.length) return null;
    return ids.length === 1 ? ids[0] : { $in: ids };
  }

  const str = String(value);
  const parts = str
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : { $in: parts };
}

function mapLocalizedRef(ref, normalizedLang) {
  if (!ref) return null;

  // If it's a populated document, expose only id, slug, and localized name
  if (typeof ref === "object" && ref._id) {
    return {
      id: ref._id,
      slug: ref.slug,
      name: pickLocalizedField(ref, "name", normalizedLang),
    };
  }

  // Fallback: just return the id wrapper
  return { id: ref };
}

function computeProductStock(product) {
  if (!product) return 0;

  if (product.type === productTypeEnum.SIMPLE) {
    return computeTotalStockForSimple(product);
  }
  if (product.type === productTypeEnum.VARIANT) {
    return computeTotalStockForVariants(product);
  }

  return 0;
}

function computeProductStockForWarehouse(product, warehouseId) {
  if (!product || !warehouseId) return computeProductStock(product);

  const wid = String(warehouseId);

  if (product.type === productTypeEnum.SIMPLE) {
    const stocks = Array.isArray(product.warehouseStocks)
      ? product.warehouseStocks
      : [];
    const entry = stocks.find((s) => String(s?.warehouse) === wid);
    return typeof entry?.quantity === "number" ? entry.quantity : 0;
  }

  if (product.type === productTypeEnum.VARIANT) {
    const variants = Array.isArray(product.variants) ? product.variants : [];

    return variants.reduce((sum, v) => {
      const stocks = Array.isArray(v?.warehouseStocks) ? v.warehouseStocks : [];
      const entry = stocks.find((s) => String(s?.warehouse) === wid);
      const qty = typeof entry?.quantity === "number" ? entry.quantity : 0;
      return sum + qty;
    }, 0);
  }

  return 0;
}

function buildInStockFilter(warehouseId, productType) {
  const stockMatch = warehouseId
    ? {
        warehouse: String(warehouseId),
        quantity: { $gt: 0 },
      }
    : { quantity: { $gt: 0 } };

  const simpleFilter = {
    type: productTypeEnum.SIMPLE,
    warehouseStocks: { $elemMatch: stockMatch },
  };
  const variantFilter = {
    type: productTypeEnum.VARIANT,
    variants: {
      $elemMatch: {
        warehouseStocks: { $elemMatch: stockMatch },
      },
    },
  };

  if (productType === productTypeEnum.SIMPLE) return simpleFilter;
  if (productType === productTypeEnum.VARIANT) return variantFilter;

  return { $or: [simpleFilter, variantFilter] };
}

function computeCardPricingForProduct(product, promoPercent) {
  let cardPrice = typeof product?.price === "number" ? product.price : null;
  let cardDiscountedPrice =
    typeof product?.discountedPrice === "number"
      ? product.discountedPrice
      : null;
  let appliedPromotionForCard = false;

  if (
    product?.type === productTypeEnum.VARIANT &&
    Array.isArray(product.variants) &&
    product.variants.length > 0
  ) {
    let minBasePrice = Infinity;
    let minFinalEffective = Infinity;
    let minFinalFromPromotion = false;

    for (const v of product.variants) {
      const basePrice = typeof v.price === "number" ? v.price : null;
      if (basePrice == null) continue;

      const baseDiscounted =
        typeof v.discountedPrice === "number" ? v.discountedPrice : null;

      if (basePrice < minBasePrice) {
        minBasePrice = basePrice;
      }

      const pricing = computeFinalDiscountedPrice({
        price: basePrice,
        discountedPrice: baseDiscounted,
        promoPercent,
      });

      if (typeof pricing.finalEffective === "number") {
        if (pricing.finalEffective < minFinalEffective) {
          minFinalEffective = pricing.finalEffective;
          minFinalFromPromotion = !!pricing.appliedPromotion;
        }
      }
    }

    cardPrice = minBasePrice !== Infinity ? minBasePrice : null;
    cardDiscountedPrice =
      cardPrice != null &&
      minFinalEffective !== Infinity &&
      minFinalEffective < cardPrice
        ? minFinalEffective
        : null;
    appliedPromotionForCard = !!minFinalFromPromotion;
  } else {
    const pricing = computeFinalDiscountedPrice({
      price: cardPrice,
      discountedPrice: cardDiscountedPrice,
      promoPercent,
    });

    cardPrice =
      typeof pricing.basePrice === "number" ? pricing.basePrice : null;
    cardDiscountedPrice =
      typeof pricing.final === "number" ? pricing.final : null;
    appliedPromotionForCard = !!pricing.appliedPromotion;
  }

  return { cardPrice, cardDiscountedPrice, appliedPromotionForCard };
}

function mapProductToCardDto(p, { lang, promotion, warehouseId } = {}) {
  const normalizedLang = normalizeLang(lang);
  const mainImage = pickMainImage(p.images);

  const stock = warehouseId
    ? computeProductStockForWarehouse(p, warehouseId)
    : computeProductStock(p);

  const promoPercent =
    promotion && typeof promotion.discountPercent === "number"
      ? promotion.discountPercent
      : null;

  const { cardPrice, cardDiscountedPrice, appliedPromotionForCard } =
    computeCardPricingForProduct(p, promoPercent);

  const category = mapLocalizedRef(p.category, normalizedLang);
  const subcategory = mapLocalizedRef(p.subcategory, normalizedLang);
  const brand = mapLocalizedRef(p.brand, normalizedLang);

  return {
    id: p._id,
    slug: p.slug,
    name: pickLocalizedField(p, "name", normalizedLang),
    type: p.type,
    isActive: p.isActive !== false,
    category,
    subcategory,
    brand,
    // desc: pickLocalizedField(p, "desc", normalizedLang),
    // tags: p.tags || [],
    price: typeof cardPrice === "number" ? cardPrice : null,
    discountedPrice:
      typeof cardDiscountedPrice === "number" ? cardDiscountedPrice : null,
    promotion: appliedPromotionForCard ? promotion || null : null,
    stock,
    inStock: stock > 0,
    image: mainImage?.url || null,
    hasVariants:
      p.type === productTypeEnum.VARIANT &&
      Array.isArray(p.variants) &&
      p.variants.length > 0,
    ratingAverage: typeof p.ratingAverage === "number" ? p.ratingAverage : 0,
    ratingCount: typeof p.ratingCount === "number" ? p.ratingCount : 0,
  };
}

function computeDetailPricingForProduct(product, promoPercent, warehouseId) {
  if (
    product?.type === productTypeEnum.VARIANT &&
    Array.isArray(product.variants) &&
    product.variants.length > 0
  ) {
    let startsAtFinalEffective = Infinity;
    let startsAtFinalFromPromotion = false;

    const variants = product.variants.map((v, index) => {
      const basePrice = typeof v.price === "number" ? v.price : null;
      const baseDiscounted =
        typeof v.discountedPrice === "number" ? v.discountedPrice : null;

      const pricing = computeFinalDiscountedPrice({
        price: basePrice,
        discountedPrice: baseDiscounted,
        promoPercent,
      });

      if (typeof pricing.finalEffective === "number") {
        if (pricing.finalEffective < startsAtFinalEffective) {
          startsAtFinalEffective = pricing.finalEffective;
          startsAtFinalFromPromotion = !!pricing.appliedPromotion;
        }
      }

      const rawStocks = Array.isArray(v.warehouseStocks)
        ? v.warehouseStocks
        : [];

      let filteredStocks;
      if (warehouseId) {
        const wid = String(warehouseId);
        filteredStocks = rawStocks.filter(
          (ws) => String(ws?.warehouse) === wid,
        );
      } else {
        filteredStocks = rawStocks;
      }

      const variantStock = filteredStocks.reduce(
        (sum, ws) => sum + (typeof ws?.quantity === "number" ? ws.quantity : 0),
        0,
      );

      // Reverse-map variant image to product-level imageIndex so the FE
      // can round-trip it on subsequent updates.
      let imageIndex = null;
      if (
        Array.isArray(v.images) &&
        v.images.length > 0 &&
        Array.isArray(product.images)
      ) {
        const variantImageId = v.images[0]?.public_id;
        if (variantImageId) {
          const idx = product.images.findIndex(
            (img) => img.public_id === variantImageId,
          );
          if (idx >= 0) imageIndex = idx;
        }
      }

      return {
        id: v._id || null,
        index,
        sku: v.sku || null,
        price: typeof pricing.basePrice === "number" ? pricing.basePrice : null,
        discountedPrice:
          typeof pricing.final === "number" ? pricing.final : null,
        options: Array.isArray(v.options) ? v.options : [],
        imageIndex,
        images: Array.isArray(v.images)
          ? v.images.map((img) => ({
              // public_id: img.public_id,
              url: img.url,
            }))
          : [],
        warehouseStocks: filteredStocks.map((ws) => ({
          warehouse: ws.warehouse,
          quantity: ws.quantity,
        })),
        stock: variantStock,
        inStock: variantStock > 0,
        isDefault: !!v.isDefault,
      };
    });

    const basePrices = variants
      .map((v) => v.price)
      .filter((n) => typeof n === "number");
    const basePrice = basePrices.length > 0 ? Math.min(...basePrices) : null;

    const finalDiscountedPrice =
      typeof basePrice === "number" &&
      startsAtFinalEffective !== Infinity &&
      startsAtFinalEffective < basePrice
        ? startsAtFinalEffective
        : null;

    return {
      basePrice,
      finalDiscountedPrice,
      appliedPromotionForProduct: !!startsAtFinalFromPromotion,
      variants,
    };
  }

  const pricing = computeFinalDiscountedPrice({
    price: typeof product?.price === "number" ? product.price : null,
    discountedPrice:
      typeof product?.discountedPrice === "number"
        ? product.discountedPrice
        : null,
    promoPercent,
  });

  return {
    basePrice: typeof pricing.basePrice === "number" ? pricing.basePrice : null,
    finalDiscountedPrice:
      typeof pricing.final === "number" ? pricing.final : null,
    appliedPromotionForProduct: !!pricing.appliedPromotion,
    variants: undefined,
  };
}

function mapProductToDetailDto(
  product,
  { lang, promotion, includeAllLanguages, warehouseId } = {},
) {
  const normalizedLang = normalizeLang(lang);

  const mainImage = pickMainImage(product.images);
  const stock = warehouseId
    ? computeProductStockForWarehouse(product, warehouseId)
    : computeProductStock(product);

  const images = Array.isArray(product.images)
    ? product.images.map((img) => ({
        public_id: img.public_id,
        url: img.url,
        isMain: !!img.isMain,
      }))
    : [];

  const promoPercent =
    promotion && typeof promotion.discountPercent === "number"
      ? promotion.discountPercent
      : null;

  const {
    basePrice,
    finalDiscountedPrice,
    appliedPromotionForProduct,
    variants,
  } = computeDetailPricingForProduct(product, promoPercent, warehouseId);

  let warehouseStocks = [];
  if (
    product.type === productTypeEnum.SIMPLE &&
    Array.isArray(product.warehouseStocks)
  ) {
    if (warehouseId) {
      const wid = String(warehouseId);
      warehouseStocks = product.warehouseStocks
        .filter((ws) => String(ws?.warehouse) === wid)
        .map((ws) => ({ warehouse: ws.warehouse, quantity: ws.quantity }));
    } else {
      warehouseStocks = product.warehouseStocks.map((ws) => ({
        warehouse: ws.warehouse,
        quantity: ws.quantity,
      }));
    }
  }

  const category = mapLocalizedRef(product.category, normalizedLang);
  const subcategory = mapLocalizedRef(product.subcategory, normalizedLang);
  const brand = mapLocalizedRef(product.brand, normalizedLang);

  return {
    id: product._id,
    slug: product.slug,
    type: product.type,
    isActive: product.isActive !== false,
    category,
    subcategory,
    brand,
    ...(includeAllLanguages
      ? {
          name: pickLocalizedField(product, "name", normalizedLang),
          name_en: product.name_en,
          name_ar: product.name_ar,
          desc: pickLocalizedField(product, "desc", normalizedLang),
          desc_en: product.desc_en,
          desc_ar: product.desc_ar,
        }
      : {
          name: pickLocalizedField(product, "name", normalizedLang),
          desc: pickLocalizedField(product, "desc", normalizedLang),
        }),
    sku: product.sku || null,
    tags: product.tags || [],
    price:
      product.type === productTypeEnum.SIMPLE
        ? typeof basePrice === "number"
          ? basePrice
          : null
        : null,
    discountedPrice:
      product.type === productTypeEnum.SIMPLE
        ? typeof finalDiscountedPrice === "number"
          ? finalDiscountedPrice
          : null
        : null,
    promotion: appliedPromotionForProduct ? promotion || null : null,
    stock,
    inStock: stock > 0,
    images,
    mainImage: mainImage?.url || null,
    options:
      Array.isArray(product.options) && product.options.length > 0
        ? product.options
        : undefined,
    variants,
    warehouseStocks,
    ratingAverage:
      typeof product.ratingAverage === "number" ? product.ratingAverage : 0,
    ratingCount:
      typeof product.ratingCount === "number" ? product.ratingCount : 0,
  };
}

async function resolveCollectionFilter(collectionId) {
  if (!collectionId) return null;

  let collection;
  try {
    collection = await findCollectionById(collectionId)
      .select("selector isVisible")
      .lean();
  } catch (err) {
    if (err?.name === "CastError") {
      throw new ApiError("Invalid collection id", 400);
    }
    throw err;
  }

  if (!collection || !collection.isVisible) {
    return { _id: null };
  }

  const { productIds, subcategoryIds, brandIds } = collection.selector || {};
  const orConditions = [];

  if (Array.isArray(productIds) && productIds.length > 0) {
    orConditions.push({ _id: { $in: productIds } });
  }

  if (Array.isArray(subcategoryIds) && subcategoryIds.length > 0) {
    // Inclusive browsing: expand each subcategory to include all nested children
    const expandedIds = new Set(subcategoryIds.map(String));
    await Promise.all(
      subcategoryIds.map(async (id) => {
        const childIds = await getSubcategoryChildrenIds(id);
        childIds.forEach((cid) => expandedIds.add(String(cid)));
      }),
    );
    orConditions.push({ subcategory: { $in: [...expandedIds] } });
  }

  if (Array.isArray(brandIds) && brandIds.length > 0) {
    orConditions.push({ brand: { $in: brandIds } });
  }

  if (orConditions.length === 0) {
    // Empty selector matches nothing
    return { _id: null };
  }

  return { $or: orConditions };
}

async function getProductsService(
  queryParams = {},
  lang = "en",
  options = {},
  userId = null,
  guestId = null,
) {
  const {
    page,
    limit,
    sortKey,
    q,
    category,
    subcategory,
    brand,
    warehouse,
    type,
    isFeatured,
    isActive,
    minPrice,
    maxPrice,
    collection,
    ...rest
  } = queryParams;

  const normalizedLang = normalizeLang(lang);
  const {
    includeZeroStockInWarehouse = false,
    prioritizeInStock = false,
    onlyActive = false,
    hideOutOfStock = false,
  } = options || {};

  const effectiveWarehouseId =
    warehouse && (!includeZeroStockInWarehouse || prioritizeInStock)
      ? String((await resolveEffectiveWarehouse(warehouse)).effectiveWarehouse._id)
      : warehouse;

  const filter = {};

  // Type filter (SIMPLE vs VARIANT), case-insensitive
  const normalizedType = normalizeProductType(type);
  if (normalizedType) {
    filter.type = normalizedType;
  }

  // Category / subcategory / brand filters (support comma-separated lists)
  const categoryFilter = parseIdFilter(category);
  if (categoryFilter) filter.category = categoryFilter;

  // Subcategory filter with inclusive browsing:
  // When a single subcategory is queried, also include all its nested children
  // so that browsing "Cat Treats" shows products from Cat Treats + all sub-subcategories.
  let subcategoryFilter = parseIdFilter(subcategory);
  if (subcategoryFilter && typeof subcategoryFilter === "string") {
    const childIds = await getSubcategoryChildrenIds(subcategoryFilter);
    if (childIds.length) {
      subcategoryFilter = { $in: [subcategoryFilter, ...childIds.map(String)] };
    }
  }
  if (subcategoryFilter) filter.subcategory = subcategoryFilter;

  const brandFilter = parseIdFilter(brand);
  if (brandFilter) filter.brand = brandFilter;

  // isFeatured / isActive flags
  if (isFeatured !== undefined) {
    if (isFeatured === true || isFeatured === "true") filter.isFeatured = true;
    else if (isFeatured === false || isFeatured === "false")
      filter.isFeatured = false;
  }

  if (isActive !== undefined) {
    if (isActive === true || isActive === "true") filter.isActive = true;
    else if (isActive === false || isActive === "false")
      filter.isActive = false;
  }

  // User-facing listings must never expose inactive products. Apply this
  // after the optional query filter so ?isActive=false cannot override it.
  if (onlyActive) {
    filter.isActive = true;
  }

  const parsedMinPrice = parseProductPriceBound(minPrice, "minPrice");
  const parsedMaxPrice = parseProductPriceBound(maxPrice, "maxPrice");
  if (
    parsedMinPrice !== undefined &&
    parsedMaxPrice !== undefined &&
    parsedMinPrice > parsedMaxPrice
  ) {
    throw new ApiError("minPrice cannot be greater than maxPrice", 400);
  }

  let priceRangeFilter = null;
  if (parsedMinPrice !== undefined || parsedMaxPrice !== undefined) {
    const price = {
      ...(parsedMinPrice !== undefined && { $gte: parsedMinPrice }),
      ...(parsedMaxPrice !== undefined && { $lte: parsedMaxPrice }),
    };

    // Simple products use their product price; variant products match when at
    // least one variant price is in the requested inclusive range.
    priceRangeFilter = {
      $or: [
        { type: productTypeEnum.SIMPLE, price },
        {
          type: productTypeEnum.VARIANT,
          variants: { $elemMatch: { price } },
        },
      ],
    };
  }

  // Collection filter
  if (collection) {
    const collectionFilter = await resolveCollectionFilter(collection);
    Object.assign(filter, collectionFilter);
  }

  // Free-text search on names, tags, product/variant SKUs, and matched brands.
  const orConditions = [];
  if (typeof q === "string" && q.trim()) {
    const regex = {
      $regex: buildFlexibleSearchPattern(q.trim()),
      $options: "i",
    };
    orConditions.push(
      { name_en: regex },
      { name_ar: regex },
      { tags: regex },
      { sku: regex },
      { "variants.sku": regex },
    );

    // Also search by brand name — find brands matching q, then include their products
    const matchedBrands = await BrandModel.find({
      $or: [{ name_en: regex }, { name_ar: regex }],
    })
      .select("_id")
      .lean();

    if (matchedBrands.length > 0) {
      orConditions.push({ brand: { $in: matchedBrands.map((b) => b._id) } });
    }
  }

  // Generic regex filters for any extra query keys
  const extraFilter = buildRegexFilter(rest, []);
  Object.assign(filter, extraFilter);

  // warehouse filter: only include products that have stock > 0
  // in the given warehouse. This applies to both SIMPLE and VARIANT products.
  let warehouseFilter = null;
  let selectedWarehouseId = null;
  if (effectiveWarehouseId) {
    const warehouseId = Array.isArray(effectiveWarehouseId)
      ? String(effectiveWarehouseId[0])
      : String(effectiveWarehouseId);

    if (warehouseId) {
      selectedWarehouseId = warehouseId;

      // Admins: skip the warehouse filter so products with no stock entry
      // (not just quantity 0, but missing from warehouseStocks entirely)
      // are still returned.
      if (!includeZeroStockInWarehouse) {
        warehouseFilter = buildInStockFilter(warehouseId, filter.type);
      }
    }
  }

  // Temporary public-catalog behavior: omit unavailable products completely.
  // With a selected warehouse, stock is checked in that warehouse; without
  // one, a product is included only when it has stock in at least one warehouse.
  const inStockFilter = hideOutOfStock
    ? buildInStockFilter(selectedWarehouseId, filter.type)
    : null;

  const andConditions = [filter];
  if (priceRangeFilter) {
    andConditions.push(priceRangeFilter);
  }
  if (warehouseFilter) {
    andConditions.push(warehouseFilter);
  }
  if (inStockFilter) {
    andConditions.push(inStockFilter);
  }
  if (orConditions.length) {
    andConditions.push({ $or: orConditions });
  }

  const mongoFilter =
    andConditions.length === 1 ? andConditions[0] : { $and: andConditions };

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 10);

  const useBestSellerSort = isBestSellerSort(sortKey);
  let sort = useBestSellerSort
    ? { createdAt: -1 }
    : mapProductSortKey(sortKey);
  if (!sort) {
    sort = buildSort(queryParams, "-createdAt");
  }

  const fetchProductList = async () => {
    await autoHideExpiredCollectionsThrottled();

    const findPage = (pageFilter, pageSkip, pageLimit) =>
      useBestSellerSort
        ? findBestSellingProducts({
            mongoFilter: pageFilter,
            skip: pageSkip,
            limit: pageLimit,
            select: PRODUCT_CARD_SELECT,
            fallbackSort: sort,
          })
        : findProducts(pageFilter, {
            skip: pageSkip,
            limit: pageLimit,
            sort,
            select: PRODUCT_CARD_SELECT,
            lean: true,
          });

    let totalProductsCount;
    let products;

    if (prioritizeInStock) {
      const inStockFilter = buildInStockFilter(selectedWarehouseId, filter.type);
      const inStockMongoFilter = { $and: [mongoFilter, inStockFilter] };
      const outOfStockMongoFilter = {
        $and: [mongoFilter, { $nor: [inStockFilter] }],
      };

      const [totalCount, inStockCount] = await Promise.all([
        countProducts(mongoFilter),
        countProducts(inStockMongoFilter),
      ]);
      totalProductsCount = totalCount;

      if (skip < inStockCount) {
        const inStockLimit = Math.min(limitNum, inStockCount - skip);
        const outOfStockLimit = limitNum - inStockLimit;
        const [inStockProducts, outOfStockProducts] = await Promise.all([
          findPage(inStockMongoFilter, skip, inStockLimit),
          outOfStockLimit > 0
            ? findPage(outOfStockMongoFilter, 0, outOfStockLimit)
            : Promise.resolve([]),
        ]);
        products = [...inStockProducts, ...outOfStockProducts];
      } else {
        products = await findPage(
          outOfStockMongoFilter,
          skip - inStockCount,
          limitNum,
        );
      }
    } else {
      [totalProductsCount, products] = await Promise.all([
        countProducts(mongoFilter),
        findPage(mongoFilter, skip, limitNum),
      ]);
    }

    const now = new Date();
    const promotionsByProductId = await findActivePromotionsForProducts(
      products,
      now,
    );

    const data = products.map((p) => {
      const promotion = promotionsByProductId.get(String(p._id)) || null;
      const dto = mapProductToCardDto(p, {
        lang: normalizedLang,
        promotion,
        warehouseId: selectedWarehouseId,
      });
      dto.isFavorite = false;
      dto.isRestockNotificationRequested = false;
      return dto;
    });

    const totalPages = Math.ceil(totalProductsCount / limitNum) || 1;

    return {
      totalResults: totalProductsCount,
      totalPages,
      page: pageNum,
      results: data.length,
      data,
    };
  };

  const shouldCachePublicList = onlyActive;
  const productListResult = shouldCachePublicList
    ? await getOrSetCache(
        `products:list:v2:${await getProductListCacheVersion()}:${normalizedLang}:${stableStringify({
          queryParams,
          warehouse: selectedWarehouseId || null,
          onlyActive,
        })}`,
        productCacheConfig.listTtlSeconds,
        fetchProductList,
      )
    : await fetchProductList();

  if (!userId && !guestId) {
    return productListResult;
  }

  const productIds = (productListResult.data || []).map((dto) => dto.id);
  const [favoriteProductIds, restockSubscribedProductIds] = await Promise.all([
    getFavoriteProductIdsForIdentity({ userId, guestId }),
    getRestockSubscribedProductIdsForUser({
      userId,
      guestId,
      productIds,
      warehouseId: selectedWarehouseId,
    }),
  ]);
  const data = (productListResult.data || []).map((dto) => ({
    ...dto,
    isFavorite: favoriteProductIds.has(String(dto.id)),
    isRestockNotificationRequested: restockSubscribedProductIds.has(
      String(dto.id),
    ),
  }));

  return {
    ...productListResult,
    data,
  };
}

async function getMyRestockSubscribedProductsService({
  userId,
  guestId,
  lang = "en",
} = {}) {
  const normalizedLang = normalizeLang(lang);
  const subscriptions = await getMyRestockSubscriptionsService({
    userId,
    guestId,
  });

  const productIds = [
    ...new Set(
      subscriptions
        .map((subscription) => subscription.productId)
        .filter(Boolean)
        .map(String),
    ),
  ];
  if (!productIds.length) return [];

  const products = await findProducts(
    { _id: { $in: productIds }, isActive: true },
    { select: PRODUCT_CARD_SELECT, lean: true },
  );
  const [promotionsByProductId, favoriteProductIds] = await Promise.all([
    findActivePromotionsForProducts(products, new Date()),
    getFavoriteProductIdsForIdentity({ userId, guestId }),
  ]);
  const productById = new Map(
    products.map((product) => [String(product._id), product]),
  );

  return subscriptions
    .map((subscription) => {
      const product = productById.get(String(subscription.productId));
      if (!product) return null;

      return {
        ...mapProductToCardDto(product, {
          lang: normalizedLang,
          promotion:
            promotionsByProductId.get(String(product._id)) || null,
          warehouseId: subscription.warehouseId,
        }),
        warehouseId: subscription.warehouseId,
        isFavorite: favoriteProductIds.has(String(product._id)),
        isRestockNotificationRequested: true,
      };
    })
    .filter(Boolean);
}

async function getProductByIdService(
  id,
  lang = "en",
  user = null,
  warehouseId = null,
  guestId = null,
) {
  const normalizedLang = normalizeLang(lang);
  const includeAllLanguages =
    user &&
    (user.role === roles.SUPER_ADMIN ||
      (user.role === roles.ADMIN &&
        user.enabledControls?.includes(enabledControls.PRODUCTS)));

  if (warehouseId && !includeAllLanguages) {
    warehouseId = String(
      (await resolveEffectiveWarehouse(warehouseId)).effectiveWarehouse._id,
    );
  }

  const whPart = warehouseId ? `:wh:${warehouseId}` : "";
  const cacheKey = `product:${id}:${normalizedLang}:${includeAllLanguages ? "all" : "localized"}${whPart}`;

  const result = await getOrSetCache(cacheKey, productCacheConfig.detailTtlSeconds, async () => {
    await autoHideExpiredCollections();

    const product = await findProductByIdWithRefs(id);

    if (!product) {
      throw new ApiError(`No product found for this id: ${id}`, 404);
    }

    const promotion = await findActivePromotionForProduct(
      {
        productId: product._id,
        subcategoryId: product.subcategory?._id || product.subcategory,
        brandId: product.brand?._id || product.brand,
      },
      new Date(),
    );

    return mapProductToDetailDto(product, {
      lang: normalizedLang,
      promotion,
      includeAllLanguages,
      warehouseId,
    });
  });

  // isFavorite is user-specific, so add it outside the cache.
  // Shallow-clone to avoid mutating the cached object.
  const userId = user?._id || user?.id || null;
  const favoriteProductIds = await getFavoriteProductIdsForIdentity({
    userId,
    guestId,
  });
  const output = { ...result };
  output.isFavorite = favoriteProductIds.has(String(id));
  output.isRestockNotificationRequested = false;

  if ((userId || guestId) && warehouseId) {
    const restockStatus = await getRestockSubscriptionStatusService({
      userId,
      guestId,
      productId: id,
      warehouseId,
    });
    output.isRestockNotificationRequested = restockStatus.subscribed;
  }

  return output;
}

async function ensureSubcategoryAndCategory(subcategoryId) {
  const subcategory = await findSubcategoryById(subcategoryId)
    .select("category name_en")
    .populate("category", "name_en");
  if (!subcategory) {
    throw new ApiError(
      `No subcategory found for this id: ${subcategoryId}`,
      400,
    );
  }
  const categoryRef = subcategory.category;
  const categoryId =
    typeof categoryRef === "object" ? categoryRef._id : categoryRef;
  if (!categoryId) {
    throw new ApiError(
      `Subcategory with id ${subcategoryId} does not have a linked category`,
      500,
    );
  }
  return {
    subcategoryId,
    categoryId,
    subcategoryName: subcategory.name_en || null,
    categoryName:
      typeof categoryRef === "object" ? categoryRef.name_en || null : null,
  };
}

async function ensureBrandExists(brandId) {
  if (!brandId) return null;
  const exists = await brandExists({ _id: brandId });
  if (!exists) {
    throw new ApiError(`No brand found for this id: ${brandId}`, 400);
  }
  return brandId;
}

async function ensureWarehousesExist(warehouseIds) {
  const uniqueIds = Array.from(new Set(warehouseIds.map((id) => String(id))));
  if (uniqueIds.length === 0) return;

  const count = await countWarehouses({
    _id: { $in: uniqueIds },
  });
  if (count !== uniqueIds.length) {
    throw new ApiError("One or more warehouses do not exist", 400);
  }
}

function mapWarehouseStocks(rawStocks, existingStocks = []) {
  if (!Array.isArray(rawStocks)) return [];
  const existingByWarehouse = new Map(
    (Array.isArray(existingStocks) ? existingStocks : [])
      .filter((stock) => stock?.warehouse)
      .map((stock) => [String(stock.warehouse), stock]),
  );

  return rawStocks.map((ws) => {
    const warehouse = ws.warehouse;
    const quantity =
      typeof ws.quantity === "number" ? ws.quantity : Number(ws.quantity) || 0;
    const existing = existingByWarehouse.get(String(warehouse));
    const previousQuantity =
      typeof existing?.quantity === "number" ? existing.quantity : null;
    const previousRevision =
      Number.isInteger(existing?.revision) && existing.revision >= 0
        ? existing.revision
        : 0;

    return {
      warehouse,
      quantity,
      revision:
        previousQuantity === null
          ? 0
          : previousQuantity === quantity
            ? previousRevision
            : previousRevision + 1,
    };
  });
}

async function getAllWarehouseIds() {
  const warehouses = await findWarehouseIds();
  return warehouses.map((warehouse) => warehouse._id);
}

// Maps raw variant payloads into clean variant subdocuments.
// - productImages: used to resolve imageIndex into a concrete image object.
// - existingVariantsById (optional): when provided, and when the payload
//   includes an _id that matches an existing variant, we reuse that _id so
//   variant identity stays stable across updates (important for carts/orders).
function mapVariantPayloads(
  rawVariants,
  productImages,
  existingVariantsById,
  warehouseIds,
) {
  if (!Array.isArray(rawVariants)) return [];

  const hasProductImages =
    Array.isArray(productImages) && productImages.length > 0;

  return rawVariants.map((v) => {
    let isDefault = false;
    if (typeof v.isDefault === "boolean") {
      isDefault = v.isDefault;
    } else if (typeof v.isDefault === "string") {
      const flag = v.isDefault.trim().toLowerCase();
      if (flag === "true" || flag === "1" || flag === "yes" || flag === "on") {
        isDefault = true;
      }
    }

    const doc = {
      sku: v.sku,
      price: typeof v.price === "number" ? v.price : Number(v.price) || 0,
      discountedPrice:
        typeof v.discountedPrice === "number"
          ? v.discountedPrice
          : v.discountedPrice != null
            ? Number(v.discountedPrice) || 0
            : undefined,
      options: Array.isArray(v.options)
        ? v.options
            .map((o) => ({
              name: typeof o.name === "string" ? o.name.trim() : "",
              value: typeof o.value === "string" ? o.value.trim() : "",
            }))
            .filter((o) => o.name && o.value)
        : [],
      warehouseStocks: mapWarehouseStocks(
        warehouseIds
          ? completeWarehouseStocks(v.warehouseStocks, warehouseIds)
          : v.warehouseStocks,
        existingVariantsById?.get(String(v._id))?.warehouseStocks,
      ),
      isDefault,
    };

    // When updating an existing product, try to preserve the variant _id if
    // the payload provided one and it exists on the current product.
    if (existingVariantsById && v._id) {
      const existing = existingVariantsById.get(String(v._id));
      if (existing && existing._id) {
        doc._id = existing._id;
      }
    }

    if (hasProductImages && v.imageIndex != null) {
      const idx = Number(v.imageIndex);
      if (!Number.isNaN(idx) && idx >= 0 && idx < productImages.length) {
        const baseImage = productImages[idx];
        if (baseImage) {
          // Attach a single image to this variant by reusing the
          // already-uploaded product image metadata (no extra upload).
          doc.images = [baseImage];
        }
      }
    }

    return doc;
  });
}

async function uploadProductImages(files, slug, mainImageIndex) {
  if (!Array.isArray(files) || files.length === 0) {
    return { images: [], uploadedImages: [] };
  }

  const shortSlug = slug.length > 60 ? slug.slice(0, 60) : slug;

  const uploadPromises = files.map((file, index) => {
    validateImageFile(file);
    return uploadImage(file, {
      folder: `petyard/products/${shortSlug}`,
      publicId: `product_${shortSlug}_${index}_${Date.now()}`,
      visibility: IMAGE_VISIBILITY.PUBLIC,
      profile: IMAGE_UPLOAD_PROFILES.STANDARD,
    });
  });

  const results = await Promise.allSettled(uploadPromises);

  const images = [];
  const uploadedImages = [];
  let firstError = null;

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      uploadedImages.push(result.value);
      images.push({ ...result.value, isMain: false });
    } else if (result.status === "rejected" && !firstError) {
      firstError = result.reason;
    }
  }

  if (firstError) {
    for (const uploadedImage of uploadedImages) {
      await deleteImage(uploadedImage);
    }
    throw firstError instanceof ApiError
      ? firstError
      : new ApiError("Failed to upload images", 500);
  }

  if (images.length > 0) {
    let mainIndex = 0;
    if (mainImageIndex != null) {
      const parsed = Number(mainImageIndex);
      if (!Number.isNaN(parsed)) {
        mainIndex = Math.min(Math.max(parsed, 0), images.length - 1);
      }
    }
    images[mainIndex].isMain = true;
  }

  return { images, uploadedImages };
}

function mediaDescriptorKey(image) {
  return JSON.stringify([
    typeof image?.public_id === "string" ? image.public_id.trim() : "",
    typeof image?.url === "string" ? image.url.trim() : "",
  ]);
}

function cloneMediaDescriptor(image) {
  if (!image || typeof image.url !== "string" || !image.url) {
    return null;
  }
  return {
    public_id: image.public_id ?? null,
    url: image.url,
  };
}

function cloneProductImage(image) {
  const descriptor = cloneMediaDescriptor(image);
  if (!descriptor) return null;
  return { ...descriptor, isMain: !!image.isMain };
}

function mergeProductImages(
  existingImages,
  uploadedImages,
  removedPublicIds,
  mainImageIndex,
) {
  const removedIds = new Set(removedPublicIds);
  const keptImages = existingImages.filter(
    (image) => !removedIds.has(image.public_id),
  );
  const mergedImages = [...keptImages, ...uploadedImages];

  if (mergedImages.length === 0) return [];

  let selectedMainIndex = mergedImages.findIndex((image) => image.isMain);
  const hasRequestedNewMain =
    mainImageIndex !== undefined &&
    mainImageIndex !== null &&
    String(mainImageIndex).trim() !== "";

  // In merge mode, mainImageIndex remains relative to the newly uploaded
  // files. When it is omitted, preserve the existing main image if possible.
  if (hasRequestedNewMain && uploadedImages.length > 0) {
    const parsed = Number(mainImageIndex);
    if (Number.isFinite(parsed)) {
      const uploadIndex = Math.min(
        Math.max(Math.trunc(parsed), 0),
        uploadedImages.length - 1,
      );
      selectedMainIndex = keptImages.length + uploadIndex;
    }
  }

  if (selectedMainIndex < 0) selectedMainIndex = 0;

  return mergedImages.map((image, index) => ({
    ...image,
    isMain: index === selectedMainIndex,
  }));
}

async function createProductService(payload, files = []) {
  const {
    type,
    category: payloadCategoryId,
    subcategory: subcategoryId,
    brand: brandId,
    name_en,
    name_ar,
    desc_en,
    desc_ar,
    sku,
    tags,
    price,
    discountedPrice,
    warehouseStocks,
    variants,
    options,
    mainImageIndex,
    isActive,
    isFeatured,
  } = payload;

  const normalizedType = normalizeProductType(type);
  if (!normalizedType) {
    throw new ApiError("Invalid product type. Must be SIMPLE or VARIANT", 400);
  }

  const normalizedSlug = normalizeTag(name_en);

  if (!normalizedSlug) {
    throw new ApiError("Unable to generate slug from name_en", 400);
  }

  const existing = await findProductBySlug(normalizedSlug);
  if (existing) {
    throw new ApiError(
      `Product with slug '${normalizedSlug}' already exists`,
      409,
    );
  }

  let categoryId = payloadCategoryId;
  let subcategoryName = null;
  let categoryName = null;

  if (subcategoryId) {
    const resolved = await ensureSubcategoryAndCategory(subcategoryId);
    categoryId = resolved.categoryId;
    subcategoryName = resolved.subcategoryName;
    categoryName = resolved.categoryName;
  } else if (categoryId) {
    const categoryDoc = await CategoryModel.findById(categoryId)
      .select("name_en")
      .lean();
    if (!categoryDoc)
      throw new ApiError(`No category found for this id: ${categoryId}`, 400);
    categoryName = categoryDoc.name_en;
  } else {
    throw new ApiError("category or subcategory is required", 400);
  }
  const brand = await ensureBrandExists(brandId);

  // Resolve brand name for AI context (lightweight query)
  let brandName = null;
  if (brand) {
    const brandDoc = await BrandModel.findById(brand).select("name_en").lean();
    brandName = brandDoc?.name_en || null;
  }

  const normalizedTags = normalizeTags(tags);
  const aiTags = await generateProductTags({
    name_en,
    name_ar,
    desc_en,
    desc_ar,
    subcategoryName,
    categoryName,
    brandName,
  });
  const finalTags = await mergeTagsWithAI(normalizedTags, aiTags);
  const normalizedOptions =
    normalizedType === productTypeEnum.VARIANT
      ? normalizeProductOptions(options)
      : [];

  let simpleWarehouseStocks = [];
  let simplePrice;
  let simpleDiscountedPrice;
  let allWarehouseIds;

  if (normalizedType === productTypeEnum.SIMPLE) {
    allWarehouseIds = await getAllWarehouseIds();
    simpleWarehouseStocks = completeWarehouseStocks(
      warehouseStocks,
      allWarehouseIds,
    );
    simplePrice =
      typeof price === "number"
        ? price
        : price != null
          ? Number(price) || 0
          : 0;

    simpleDiscountedPrice =
      typeof discountedPrice === "number"
        ? discountedPrice
        : discountedPrice != null
          ? Number(discountedPrice) || 0
          : undefined;
  }

  let variantDocs = [];
  if (normalizedType === productTypeEnum.VARIANT) {
    if (!Array.isArray(variants) || variants.length === 0) {
      throw new ApiError("variants are required for VARIANT products", 400);
    }

    validateVariantOptionsMatrix(normalizedOptions, variants);
    allWarehouseIds = await getAllWarehouseIds();
  }

  const { images, uploadedImages } = await uploadProductImages(
    files,
    normalizedSlug,
    mainImageIndex,
  );

  if (normalizedType === productTypeEnum.VARIANT) {
    // Map each variant to a single image (if provided) by referencing
    // the already-uploaded product images array. This avoids duplicate
    // uploads while still giving each variant its own images field.
    variantDocs = mapVariantPayloads(
      variants,
      images,
      undefined,
      allWarehouseIds,
    );
  }

  try {
    const product = await createProduct({
      slug: normalizedSlug,
      type: normalizedType,
      subcategory: subcategoryId || undefined,
      category: categoryId,
      ...(brand && { brand }),
      name_en,
      name_ar,
      desc_en,
      desc_ar,
      sku,
      tags: finalTags,
      price:
        normalizedType === productTypeEnum.SIMPLE ? simplePrice : undefined,
      discountedPrice:
        normalizedType === productTypeEnum.SIMPLE
          ? simpleDiscountedPrice
          : undefined,
      warehouseStocks:
        normalizedType === productTypeEnum.SIMPLE ? simpleWarehouseStocks : [],
      images,
      options: normalizedOptions,
      variants: normalizedType === productTypeEnum.VARIANT ? variantDocs : [],
      isActive: typeof isActive === "boolean" ? isActive : undefined,
      isFeatured: typeof isFeatured === "boolean" ? isFeatured : undefined,
    });

    await invalidateProductCaches(product._id);

    queueProductForSubcategoryDigest({ product }).catch((error) =>
      console.error(
        "[Product] Failed to queue subcategory digest:",
        error?.message || error,
      ),
    );

    return product;
  } catch (err) {
    for (const uploadedImage of uploadedImages) {
      await deleteImage(uploadedImage);
    }
    throw err;
  }
}

async function updateProductService(id, payload, files = []) {
  const product = await findProductById(id);
  if (!product) {
    throw new ApiError(`No product found for this id: ${id}`, 404);
  }

  const {
    category: payloadCategoryId,
    subcategory: subcategoryId,
    brand: brandId,
    name_en,
    name_ar,
    desc_en,
    desc_ar,
    sku,
    tags,
    price,
    discountedPrice,
    warehouseStocks,
    variants,
    options,
    mainImageIndex,
    removedImagePublicIds,
    isActive,
    isFeatured,
  } = payload;

  // Infer SIMPLE -> VARIANT conversion from the actual FE payload. PATCH does
  // not accept `type`, so options + variants are the conversion signal.
  const isSimpleToVariantChange =
    product.type === productTypeEnum.SIMPLE &&
    options !== undefined &&
    Array.isArray(variants) &&
    variants.length > 0;

  if (isSimpleToVariantChange) {
    product.type = productTypeEnum.VARIANT;
    product.price = undefined;
    product.discountedPrice = undefined;
    product.warehouseStocks = [];
  }

  let subcategoryName = null;
  let categoryName = null;

  if (payloadCategoryId !== undefined) {
    const categoryDoc = await CategoryModel.findById(payloadCategoryId)
      .select("name_en")
      .lean();
    if (!categoryDoc)
      throw new ApiError(
        `No category found for this id: ${payloadCategoryId}`,
        400,
      );
    product.category = payloadCategoryId;
    categoryName = categoryDoc.name_en;
  }

  if (subcategoryId !== undefined) {
    if (subcategoryId === null || subcategoryId === "") {
      product.subcategory = undefined;
    } else {
      const resolved = await ensureSubcategoryAndCategory(subcategoryId);
      product.subcategory = subcategoryId;
      product.category = resolved.categoryId;
      subcategoryName = resolved.subcategoryName;
      categoryName = resolved.categoryName;
    }
  }

  let brandName = null;
  if (brandId !== undefined) {
    if (brandId === null || brandId === "") {
      product.brand = undefined;
    } else {
      const brand = await ensureBrandExists(brandId);
      product.brand = brand;
      const brandDoc = await BrandModel.findById(brand)
        .select("name_en")
        .lean();
      brandName = brandDoc?.name_en || null;
    }
  }

  if (name_en !== undefined) product.name_en = name_en;
  if (name_ar !== undefined) product.name_ar = name_ar;
  if (desc_en !== undefined) product.desc_en = desc_en;
  if (desc_ar !== undefined) product.desc_ar = desc_ar;

  if (sku !== undefined) product.sku = sku;

  // Re-generate AI tags when content or classification changes
  const shouldRegenTags =
    tags !== undefined ||
    name_en !== undefined ||
    desc_en !== undefined ||
    subcategoryId !== undefined ||
    brandId !== undefined;

  if (shouldRegenTags) {
    const adminTags =
      tags !== undefined ? normalizeTags(tags) : product.tags || [];

    // Resolve names for AI context if not already available from above
    if (!subcategoryName && product.subcategory) {
      const resolved = await ensureSubcategoryAndCategory(product.subcategory);
      subcategoryName = resolved.subcategoryName;
      categoryName = resolved.categoryName;
    } else if (!categoryName && product.category) {
      const catDoc = await CategoryModel.findById(product.category)
        .select("name_en")
        .lean();
      categoryName = catDoc?.name_en || null;
    }
    if (!brandName && product.brand) {
      const brandDoc = await BrandModel.findById(product.brand)
        .select("name_en")
        .lean();
      brandName = brandDoc?.name_en || null;
    }

    const aiTags = await generateProductTags({
      name_en: product.name_en,
      name_ar: product.name_ar,
      desc_en: product.desc_en,
      desc_ar: product.desc_ar,
      subcategoryName,
      categoryName,
      brandName,
    });

    product.tags = await mergeTagsWithAI(adminTags, aiTags);
  }

  if (options !== undefined) {
    if (product.type === productTypeEnum.SIMPLE) {
      throw new ApiError("options cannot be set for SIMPLE products", 400);
    }
    product.options = normalizeProductOptions(options);
  }

  const currentVariantOptions =
    product.type === productTypeEnum.VARIANT
      ? normalizeProductOptions(product.options || [])
      : [];

  let shouldRemapVariantsFromPayload = false;
  let variantWarehouseIds;

  if (product.type === productTypeEnum.SIMPLE) {
    if (price !== undefined) {
      product.price =
        typeof price === "number"
          ? price
          : price != null
            ? Number(price) || 0
            : 0;
    }

    if (discountedPrice !== undefined) {
      product.discountedPrice =
        typeof discountedPrice === "number"
          ? discountedPrice
          : discountedPrice != null
            ? Number(discountedPrice) || 0
            : undefined;
    }

    if (warehouseStocks !== undefined) {
      const warehouseIds = await getAllWarehouseIds();
      product.warehouseStocks = mapWarehouseStocks(
        completeWarehouseStocks(warehouseStocks, warehouseIds),
        product.warehouseStocks,
      );
    }
  }

  if (product.type === productTypeEnum.VARIANT && variants !== undefined) {
    if (!Array.isArray(variants) || variants.length === 0) {
      throw new ApiError("variants are required for VARIANT products", 400);
    }

    validateVariantOptionsMatrix(currentVariantOptions, variants);
    variantWarehouseIds = await getAllWarehouseIds();
    shouldRemapVariantsFromPayload = true;
  } else if (
    product.type === productTypeEnum.VARIANT &&
    variants === undefined &&
    options !== undefined
  ) {
    // Options were updated but variants were not provided; ensure existing variants are still valid
    validateVariantOptionsMatrix(currentVariantOptions, product.variants || []);
  }

  if (isActive !== undefined) {
    product.isActive = !!isActive;
  }

  if (isFeatured !== undefined) {
    product.isFeatured = !!isFeatured;
  }

  let newUploadedImages = [];
  const { useImageMerge, publicIds: removedPublicIds } =
    parseRemovedImagePublicIds(removedImagePublicIds);
  const existingImages = Array.isArray(product.images)
    ? product.images
        .map(cloneProductImage)
        .filter(Boolean)
    : [];
  const oldImages = existingImages.map(cloneMediaDescriptor).filter(Boolean);
  let imagesWereUpdated = false;

  if (Array.isArray(files) && files.length > 0) {
    const uploadResult = await uploadProductImages(
      files,
      product.slug,
      mainImageIndex,
    );
    newUploadedImages = uploadResult.uploadedImages;
    product.images = useImageMerge
      ? mergeProductImages(
          existingImages,
          uploadResult.images,
          removedPublicIds,
          mainImageIndex,
        )
      : uploadResult.images;
    imagesWereUpdated = true;
  } else if (useImageMerge && removedPublicIds.length > 0) {
    product.images = mergeProductImages(
      existingImages,
      [],
      removedPublicIds,
      mainImageIndex,
    );
    imagesWereUpdated = true;
  }

  const finalImageKeys = new Set(
    (Array.isArray(product.images) ? product.images : []).map(
      mediaDescriptorKey,
    ),
  );
  const imagesToDeleteAfterSave = imagesWereUpdated
    ? oldImages.filter((image) => !finalImageKeys.has(mediaDescriptorKey(image)))
    : [];

  if (
    product.type === productTypeEnum.VARIANT &&
    shouldRemapVariantsFromPayload
  ) {
    const effectiveImages = Array.isArray(product.images) ? product.images : [];
    const existingVariantsById = new Map(
      Array.isArray(product.variants)
        ? product.variants.map((v) => [String(v._id), v])
        : [],
    );
    // Replace the entire variants array with the payload, preserving _id when
    // the payload includes an existing variant _id. Variants omitted from the
    // payload are treated as removed.
    product.variants = mapVariantPayloads(
      variants,
      effectiveImages,
      existingVariantsById,
      variantWarehouseIds,
    );
  }

  try {
    const updated = await product.save();

    // Only remove replaced or explicitly removed media after a successful save.
    for (const oldImage of imagesToDeleteAfterSave) {
      await deleteImage(oldImage);
    }

    await invalidateProductCaches(id);

    processRestockSubscriptionsBestEffort(id);

    return updated;
  } catch (err) {
    for (const newUploadedImage of newUploadedImages) {
      await deleteImage(newUploadedImage);
    }
    throw err;
  }
}

/**
 * Merge-based stock update.
 *
 * Unlike the full `updateProductService` which replaces the entire variants
 * array, this service only touches the specific warehouseStock entries sent
 * in the request body. All other variants, warehouses, and product fields
 * remain untouched.
 *
 * For SIMPLE products, the body should contain:
 *   { warehouseStocks: [{ warehouse, quantity }] }
 *
 * For VARIANT products, the body should contain:
 *   { variants: [{ _id, warehouseStocks: [{ warehouse, quantity }] }] }
 *
 * @param {string} id - Product ID
 * @param {Object} payload - Stock-only payload
 * @param {string[]|null} warehouseScope - If set (moderator), only these
 *   warehouse IDs are allowed. null = no restriction (admin).
 */
async function updateProductStockService(id, payload, warehouseScope) {
  const product = await findProductById(id);
  if (!product) {
    throw new ApiError(`No product found for this id: ${id}`, 404);
  }

  // Build allowed warehouse set (null = admin, no restriction)
  const scopeSet = warehouseScope
    ? new Set(warehouseScope.map(String))
    : null;

  const incomingWarehouseIds =
    product.type === productTypeEnum.SIMPLE
      ? (Array.isArray(payload.warehouseStocks)
          ? payload.warehouseStocks
          : []
        )
          .map((entry) => entry?.warehouse)
          .filter(Boolean)
      : (Array.isArray(payload.variants) ? payload.variants : []).flatMap(
          (variant) =>
            (Array.isArray(variant?.warehouseStocks)
              ? variant.warehouseStocks
              : []
            )
              .map((entry) => entry?.warehouse)
              .filter(Boolean),
        );

  await ensureWarehousesExist(incomingWarehouseIds);

  if (product.type === productTypeEnum.SIMPLE) {
    const incomingStocks = Array.isArray(payload.warehouseStocks)
      ? payload.warehouseStocks
      : [];

    for (const entry of incomingStocks) {
      if (!entry?.warehouse) continue;
      const wid = String(entry.warehouse);

      // Enforce scope for moderators
      if (scopeSet && !scopeSet.has(wid)) {
        throw new ApiError(
          "Not allowed: stock update contains a warehouse outside your scope",
          403,
        );
      }

      const quantity =
        typeof entry.quantity === "number"
          ? entry.quantity
          : Number(entry.quantity) || 0;

      const idx = product.warehouseStocks.findIndex(
        (ws) => String(ws.warehouse) === wid,
      );

      if (idx >= 0) {
        if (product.warehouseStocks[idx].quantity !== quantity) {
          product.warehouseStocks[idx].quantity = quantity;
          product.warehouseStocks[idx].revision =
            (Number.isInteger(product.warehouseStocks[idx].revision)
              ? product.warehouseStocks[idx].revision
              : 0) + 1;
        }
      } else {
        product.warehouseStocks.push({
          warehouse: entry.warehouse,
          quantity,
          revision: 0,
        });
      }
    }
  } else if (product.type === productTypeEnum.VARIANT) {
    const incomingVariants = Array.isArray(payload.variants)
      ? payload.variants
      : [];

    // Build lookup for incoming variant changes by _id
    for (const incoming of incomingVariants) {
      // Support both `_id` and `id` from FE
      const variantId = String(incoming._id || incoming.id || "");
      if (!variantId) continue;

      const variant = product.variants.find(
        (v) => String(v._id) === variantId,
      );
      if (!variant) continue;

      const incomingStocks = Array.isArray(incoming.warehouseStocks)
        ? incoming.warehouseStocks
        : [];

      for (const entry of incomingStocks) {
        if (!entry?.warehouse) continue;
        const wid = String(entry.warehouse);

        if (scopeSet && !scopeSet.has(wid)) {
          throw new ApiError(
            "Not allowed: stock update contains a warehouse outside your scope",
            403,
          );
        }

        const quantity =
          typeof entry.quantity === "number"
            ? entry.quantity
            : Number(entry.quantity) || 0;

        const idx = variant.warehouseStocks.findIndex(
          (ws) => String(ws.warehouse) === wid,
        );

        if (idx >= 0) {
          if (variant.warehouseStocks[idx].quantity !== quantity) {
            variant.warehouseStocks[idx].quantity = quantity;
            variant.warehouseStocks[idx].revision =
              (Number.isInteger(variant.warehouseStocks[idx].revision)
                ? variant.warehouseStocks[idx].revision
                : 0) + 1;
          }
        } else {
          variant.warehouseStocks.push({
            warehouse: entry.warehouse,
            quantity,
            revision: 0,
          });
        }
      }
    }
  }

  const updated = await product.save();

  await invalidateProductCaches(id);

  processRestockSubscriptionsBestEffort(id);

  return updated;
}

async function deleteProductService(id) {
  const product = await findProductById(id);
  if (!product) {
    throw new ApiError(`No product found for this id: ${id}`, 404);
  }

  const descriptorsByKey = new Map();

  const collectDescriptor = (image) => {
    const descriptor = cloneMediaDescriptor(image);
    if (descriptor) {
      descriptorsByKey.set(mediaDescriptorKey(descriptor), descriptor);
    }
  };

  if (Array.isArray(product.images)) {
    for (const img of product.images) {
      collectDescriptor(img);
    }
  }

  if (Array.isArray(product.variants)) {
    for (const v of product.variants) {
      if (Array.isArray(v.images)) {
        for (const img of v.images) {
          collectDescriptor(img);
        }
      }
    }
  }

  for (const descriptor of descriptorsByKey.values()) {
    await deleteImage(descriptor);
  }

  await deleteProductById(id);

  await invalidateProductCaches(id);

  cleanupRestockSubscriptionsForProduct(id).catch((error) =>
    console.error(
      "[Product] Failed to clean up restock subscriptions:",
      error?.message || error,
    ),
  );
}

// ─── Search Suggestions ──────────────────────────────────────────────────────
//
// Performance design:
//  • Redis cache (15 s TTL) keyed on warehouse+lang+q+limit covers the entire
//    DB workload — repeat keystrokes within the debounce window are free.
//  • isFavorite is user-specific and injected OUTSIDE the cache.
//  • Suggestions are derived ONLY from products that actually exist and are
//    in-stock — no orphan brand/name suggestions that lead to empty results.
//  • Brand lookup is used solely for widening the product filter (find products
//    whose brand name matches q). Suggestion text comes from the product
//    results themselves.
//  • autoHideExpiredCollectionsThrottled fires-and-forgets so it never blocks.
//  • All independent DB queries run in parallel via Promise.all.

export async function searchProductsService({
  q,
  warehouse,
  limit = 10,
  lang = "en",
  userId = null,
  includeZeroStock = false,
}) {
  const normalizedLang = normalizeLang(lang);
  const trimmedQ = typeof q === "string" ? q.trim() : "";

  if (!trimmedQ) {
    return { suggestions: [], products: [] };
  }

  if (!includeZeroStock) {
    warehouse = String(
      (await resolveEffectiveWarehouse(warehouse)).effectiveWarehouse._id,
    );
  }

  const regex = { $regex: buildFlexibleSearchPattern(trimmedQ), $options: "i" };
  const warehouseId = String(warehouse);
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 20);

  // Fire-and-forget — never block the search hot path
  autoHideExpiredCollectionsThrottled().catch(() => {});

  // Cache key excludes userId — isFavorite is injected after cache hit
  const cacheKey = `search:v4:${warehouseId}:${normalizedLang}:${trimmedQ.toLowerCase()}:${limitNum}${includeZeroStock ? ":admin" : ""}`;

  // ── Cached core: suggestions + product DTOs (without isFavorite) ────────────
  const { suggestions, dtos } = await getOrSetCache(cacheKey, 15, async () => {
    // Warehouse stock filter — in-stock only in the specified warehouse
    const warehouseStockFilter = {
      $or: [
        {
          type: productTypeEnum.SIMPLE,
          warehouseStocks: {
            $elemMatch: { warehouse: warehouseId, quantity: { $gt: 0 } },
          },
        },
        {
          type: productTypeEnum.VARIANT,
          variants: {
            $elemMatch: {
              warehouseStocks: {
                $elemMatch: { warehouse: warehouseId, quantity: { $gt: 0 } },
              },
            },
          },
        },
      ],
    };

    // ── Round 1: brand IDs (needed to widen the product filter) ────────────
    // We only use these IDs to find products by brand match — NOT for
    // suggestion text. Suggestion text comes exclusively from the actual
    // product results (Round 2) so we never suggest a brand with 0 products.
    const matchedBrands = await BrandModel.find({
      $or: [{ name_en: regex }, { name_ar: regex }],
    })
      .select("_id")
      .limit(20)
      .lean();

    const brandIds = matchedBrands.map((b) => b._id);

    // ── Round 2: product results (uses brandIds from round 1) ─────────────
    const productQFilter = {
      ...(!includeZeroStock ? { isActive: true } : {}),
      $or: [
        { name_en: regex },
        { name_ar: regex },
        { tags: regex },
        ...(brandIds.length > 0 ? [{ brand: { $in: brandIds } }] : []),
      ],
    };

    const listSelect =
      "_id slug type isActive name_en name_ar price discountedPrice images warehouseStocks.warehouse warehouseStocks.quantity variants.price variants.discountedPrice variants.warehouseStocks.warehouse variants.warehouseStocks.quantity ratingAverage ratingCount category subcategory brand";

    // findProducts() already populates brand with name_en, name_ar — we use
    // this to extract brand suggestion text from REAL, in-stock products.
    const rawProducts = await findProducts(
      { $and: [productQFilter, ...(includeZeroStock ? [] : [warehouseStockFilter])] },
      { limit: limitNum, select: listSelect, lean: true },
    );

    // ── Round 3: promotions (needs rawProducts from round 2) ─────────────
    const promotionsByProductId = await findActivePromotionsForProducts(
      rawProducts,
      new Date(),
    );

    // ── Build suggestions from ACTUAL product results only ────────────────
    // Every suggestion is backed by real, in-stock products.
    // A name only qualifies as a suggestion if it flexibly matches the query.
    // This keeps suggestions backed by real product/brand names while allowing
    // user spelling like "cats white" to match "Cat's White".
    // Priority: unique brand names first, then product names.
    // Truncated to SUGGESTION_MAX_LENGTH chars for mobile screens.
    const nameMatchRegex = new RegExp(
      buildFlexibleSearchPattern(trimmedQ),
      "i",
    );
    const seen = new Set();
    const suggestions = [];

    const addSuggestion = (text) => {
      if (!text || typeof text !== "string") return;
      const trimmed = text.trim();
      if (!trimmed) return;
      // Only suggest names that actually contain the query text
      if (!nameMatchRegex.test(trimmed)) return;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      suggestions.push(trimmed);
    };

    // 1) Brand names from the returned products (deduplicated)
    //    Skip placeholder brands like "Generic" / "Genaric" — not useful.
    const IGNORED_BRANDS = new Set(["generic", "genaric"]);
    for (const product of rawProducts) {
      if (suggestions.length >= 6) break;
      const brand = product.brand;
      if (!brand || typeof brand !== "object") continue;
      const brandName =
        normalizedLang === "ar"
          ? brand.name_ar || brand.name_en
          : brand.name_en;
      if (brandName && IGNORED_BRANDS.has(brandName.trim().toLowerCase()))
        continue;
      addSuggestion(brandName);
    }

    // 2) Product names from the returned products
    for (const product of rawProducts) {
      if (suggestions.length >= 6) break;
      addSuggestion(
        normalizedLang === "ar"
          ? product.name_ar || product.name_en
          : product.name_en,
      );
    }

    // ── Map to card DTOs (isFavorite defaults false — injected after cache) ─
    const dtos = rawProducts.map((p) => {
      const promotion = promotionsByProductId.get(String(p._id)) || null;
      const dto = mapProductToCardDto(p, {
        lang: normalizedLang,
        promotion,
        warehouseId,
      });
      dto.isFavorite = false; // will be overwritten outside cache
      return dto;
    });

    return { suggestions, dtos };
  });

  // ── isFavorite — user-specific, always computed fresh outside cache ─────────
  if (userId) {
    const favoriteProductIds = await getUserFavoriteProductIds(userId);
    for (const dto of dtos) {
      dto.isFavorite = favoriteProductIds.has(String(dto.id));
    }
  }

  return { suggestions, products: dtos };
}
