import {
  countProducts,
  findProducts,
  findProductById,
  findProductByIdWithRefs,
  findProductBySlug,
  createProduct,
  deleteProductById,
} from "./product.repository.js";
import { findCollectionById } from "../collection/collection.repository.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { normalizeTag, normalizeTagsInput } from "../../shared/utils/tagging.js";
import { generateProductTags, mergeTagsWithAI } from "../../shared/utils/aiTagging.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import { normalizeProductType } from "../../shared/utils/productType.js";
import { productTypeEnum, roles, enabledControls } from "../../shared/constants/enums.js";
import {
  buildPagination,
  buildSort,
  buildRegexFilter,
} from "../../shared/utils/apiFeatures.js";
import {
  validateImageFile,
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
} from "../../shared/utils/imageUpload.js";
import { getOrSetCache, deleteCacheKey } from "../../shared/utils/cache.js";
import { computeFinalDiscountedPrice } from "../../shared/utils/pricing.js";
import {
  autoHideExpiredCollections,
  findActivePromotionForProduct,
  findActivePromotionsForProducts,
} from "../collection/collection.promotion.js";
import { brandExists } from "../brand/brand.repository.js";
import { BrandModel } from "../brand/brand.model.js";
import { findSubcategoryById } from "../subcategory/subcategory.repository.js";
import { countWarehouses } from "../warehouse/warehouse.repository.js";

export {
  getProductsService,
  getProductByIdService,
  createProductService,
  updateProductService,
  deleteProductService,
  mapProductToCardDto,
};

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
}

function normalizeTags(tags) {
  return normalizeTagsInput(tags);
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
        400
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
          ", "
        )}`,
        400
      );
    }

    const variantOptionsMap = new Map();

    for (const opt of variant.options) {
      const name = typeof opt?.name === "string" ? opt.name.trim() : "";
      const value = typeof opt?.value === "string" ? opt.value.trim() : "";

      if (!name || !value) {
        throw new ApiError(
          `Variant #${label} has an option with missing name or value. Each option must have both name and value.`,
          400
        );
      }

      variantOptionsMap.set(name, value);
    }

    const missingNames = optionNames.filter(
      (name) => !variantOptionsMap.has(name)
    );
    const extraNames = [...variantOptionsMap.keys()].filter(
      (name) => !optionNames.includes(name)
    );

    if (missingNames.length || extraNames.length) {
      if (missingNames.length) {
        throw new ApiError(
          `Variant #${label} is missing options: ${missingNames.join(
            ", "
          )}. Each variant must specify all product options: ${optionNames.join(
            ", "
          )}`,
          400
        );
      }

      if (extraNames.length) {
        throw new ApiError(
          `Variant #${label} has unknown options: ${extraNames.join(
            ", "
          )}. Valid option names are: ${optionNames.join(", ")}`,
          400
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
          400
        );
      }
    }
  });
}

function computeTotalStockForSimple(product) {
  if (!Array.isArray(product.warehouseStocks)) return 0;
  return product.warehouseStocks.reduce(
    (sum, ws) => sum + (typeof ws.quantity === "number" ? ws.quantity : 0),
    0
  );
}

function computeTotalStockForVariants(product) {
  if (!Array.isArray(product.variants)) return 0;
  return product.variants.reduce((total, variant) => {
    if (!Array.isArray(variant.warehouseStocks)) return total;
    const variantStock = variant.warehouseStocks.reduce(
      (sum, ws) => sum + (typeof ws.quantity === "number" ? ws.quantity : 0),
      0
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

function computeDetailPricingForProduct(product, promoPercent) {
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

      return {
        id: v._id || null,
        index,
        sku: v.sku || null,
        price: typeof pricing.basePrice === "number" ? pricing.basePrice : null,
        discountedPrice:
          typeof pricing.final === "number" ? pricing.final : null,
        options: Array.isArray(v.options) ? v.options : [],
        images: Array.isArray(v.images)
          ? v.images.map((img) => ({
              // public_id: img.public_id,
              url: img.url,
            }))
          : [],
        warehouseStocks: Array.isArray(v.warehouseStocks)
          ? v.warehouseStocks.map((ws) => ({
              warehouse: ws.warehouse,
              quantity: ws.quantity,
            }))
          : [],
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

function mapProductToDetailDto(product, { lang, promotion, includeAllLanguages } = {}) {
  const normalizedLang = normalizeLang(lang);

  const mainImage = pickMainImage(product.images);
  const stock = computeProductStock(product);

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
  } = computeDetailPricingForProduct(product, promoPercent);

  const warehouseStocks =
    product.type === productTypeEnum.SIMPLE &&
    Array.isArray(product.warehouseStocks)
      ? product.warehouseStocks.map((ws) => ({
          warehouse: ws.warehouse,
          quantity: ws.quantity,
        }))
      : [];

  const category = mapLocalizedRef(product.category, normalizedLang);
  const subcategory = mapLocalizedRef(product.subcategory, normalizedLang);
  const brand = mapLocalizedRef(product.brand, normalizedLang);

  return {
    id: product._id,
    slug: product.slug,
    type: product.type,
    category,
    subcategory,
    brand,
    ...(includeAllLanguages
      ? {
          name_en: product.name_en,
          name_ar: product.name_ar,
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
    orConditions.push({ subcategory: { $in: subcategoryIds } });
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

async function getProductsService(queryParams = {}, lang = "en", options = {}) {
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
    collection,
    ...rest
  } = queryParams;

  const normalizedLang = normalizeLang(lang);
  const { includeZeroStockInWarehouse = false } = options || {};

  const filter = {};

  // Type filter (SIMPLE vs VARIANT), case-insensitive
  const normalizedType = normalizeProductType(type);
  if (normalizedType) {
    filter.type = normalizedType;
  }

  // Category / subcategory / brand filters (support comma-separated lists)
  const categoryFilter = parseIdFilter(category);
  if (categoryFilter) filter.category = categoryFilter;

  const subcategoryFilter = parseIdFilter(subcategory);
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

  // Collection filter
  if (collection) {
    const collectionFilter = await resolveCollectionFilter(collection);
    Object.assign(filter, collectionFilter);
  }

  // Free-text search on name_en, name_ar, sku, and tags
  const orConditions = [];
  if (typeof q === "string" && q.trim()) {
    const regex = { $regex: q.trim(), $options: "i" };
    orConditions.push(
      { name_en: regex },
      { name_ar: regex },
      { sku: regex },
      { tags: regex }
    );
  }

  // Generic regex filters for any extra query keys
  const extraFilter = buildRegexFilter(rest, []);
  Object.assign(filter, extraFilter);

  // warehouse filter: only include products that have stock > 0
  // in the given warehouse. This applies to both SIMPLE and VARIANT products.
  let warehouseFilter = null;
  let selectedWarehouseId = null;
  if (warehouse) {
    const warehouseId = Array.isArray(warehouse)
      ? String(warehouse[0])
      : String(warehouse);

    if (warehouseId) {
      selectedWarehouseId = warehouseId;
      if (filter.type === productTypeEnum.SIMPLE) {
        warehouseFilter = {
          warehouseStocks: {
            $elemMatch: {
              warehouse: warehouseId,
              ...(includeZeroStockInWarehouse ? {} : { quantity: { $gt: 0 } }),
            },
          },
        };
      } else if (filter.type === productTypeEnum.VARIANT) {
        warehouseFilter = {
          variants: {
            $elemMatch: {
              warehouseStocks: {
                $elemMatch: {
                  warehouse: warehouseId,
                  ...(includeZeroStockInWarehouse ? {} : { quantity: { $gt: 0 } }),
                },
              },
            },
          },
        };
      } else {
        warehouseFilter = {
          $or: [
            {
              type: productTypeEnum.SIMPLE,
              warehouseStocks: {
                $elemMatch: {
                  warehouse: warehouseId,
                  ...(includeZeroStockInWarehouse ? {} : { quantity: { $gt: 0 } }),
                },
              },
            },
            {
              type: productTypeEnum.VARIANT,
              variants: {
                $elemMatch: {
                  warehouseStocks: {
                    $elemMatch: {
                      warehouse: warehouseId,
                      ...(includeZeroStockInWarehouse ? {} : { quantity: { $gt: 0 } }),
                    },
                  },
                },
              },
            },
          ],
        };
      }
    }
  }

  const andConditions = [filter];
  if (warehouseFilter) {
    andConditions.push(warehouseFilter);
  }
  if (orConditions.length) {
    andConditions.push({ $or: orConditions });
  }

  const mongoFilter =
    andConditions.length === 1 ? andConditions[0] : { $and: andConditions };

  await autoHideExpiredCollectionsThrottled();

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 10);

  let sort = mapProductSortKey(sortKey);
  if (!sort) {
    sort = buildSort(queryParams, "-createdAt");
  }


  const listSelect =
    "_id slug type name_en name_ar price discountedPrice images warehouseStocks.warehouse warehouseStocks.quantity variants.price variants.discountedPrice variants.warehouseStocks.warehouse variants.warehouseStocks.quantity ratingAverage ratingCount category subcategory brand";

  const [totalProductsCount, products] = await Promise.all([
    countProducts(mongoFilter),
    findProducts(mongoFilter, {
      skip,
      limit: limitNum,
      sort,
      select: listSelect,
      lean: true,
    }),
  ]);

  const now = new Date();
  const promotionsByProductId = await findActivePromotionsForProducts(products, now);

  const data = products.map((p) => {
    const promotion = promotionsByProductId.get(String(p._id)) || null;
    return mapProductToCardDto(p, {
      lang: normalizedLang,
      promotion,
      warehouseId: selectedWarehouseId,
    });
  });

  const totalPages = Math.ceil(totalProductsCount / limitNum) || 1;

  return {
    totalPages,
    page: pageNum,
    results: data.length,
    data,
  };
}

async function getProductByIdService(id, lang = "en", user = null) {
  const normalizedLang = normalizeLang(lang);
  const includeAllLanguages =
    user &&
    (user.role === roles.SUPER_ADMIN ||
      (user.role === roles.ADMIN &&
        user.enabledControls?.includes(enabledControls.PRODUCTS)));

  const cacheKey = `product:${id}:${normalizedLang}:${includeAllLanguages ? "all" : "localized"}`;

  return getOrSetCache(cacheKey, 60, async () => {
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
      new Date()
    );

    return mapProductToDetailDto(product, {
      lang: normalizedLang,
      promotion,
      includeAllLanguages,
    });
  });
}

async function ensureSubcategoryAndCategory(subcategoryId) {
  const subcategory = await findSubcategoryById(subcategoryId)
    .select("category name_en")
    .populate("category", "name_en");
  if (!subcategory) {
    throw new ApiError(
      `No subcategory found for this id: ${subcategoryId}`,
      400
    );
  }
  const categoryRef = subcategory.category;
  const categoryId = typeof categoryRef === "object" ? categoryRef._id : categoryRef;
  if (!categoryId) {
    throw new ApiError(
      `Subcategory with id ${subcategoryId} does not have a linked category`,
      500
    );
  }
  return {
    subcategoryId,
    categoryId,
    subcategoryName: subcategory.name_en || null,
    categoryName: typeof categoryRef === "object" ? categoryRef.name_en || null : null,
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

function mapWarehouseStocks(rawStocks) {
  if (!Array.isArray(rawStocks)) return [];
  return rawStocks.map((ws) => ({
    warehouse: ws.warehouse,
    quantity:
      typeof ws.quantity === "number" ? ws.quantity : Number(ws.quantity) || 0,
  }));
}

// Maps raw variant payloads into clean variant subdocuments.
// - productImages: used to resolve imageIndex into a concrete image object.
// - existingVariantsById (optional): when provided, and when the payload
//   includes an _id that matches an existing variant, we reuse that _id so
//   variant identity stays stable across updates (important for carts/orders).
function mapVariantPayloads(rawVariants, productImages, existingVariantsById) {
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
      warehouseStocks: mapWarehouseStocks(v.warehouseStocks),
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
    return { images: [], uploadedPublicIds: [] };
  }

  const uploadPromises = files.map((file, index) => {
    validateImageFile(file);
    return uploadImageToCloudinary(file, {
      folder: `petyard/products/${slug}`,
      publicId: `product_${slug}_${index}_${Date.now()}`,
    });
  });

  const results = await Promise.allSettled(uploadPromises);

  const images = [];
  const uploadedPublicIds = [];
  let firstError = null;

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      uploadedPublicIds.push(result.value.public_id);
      images.push({ ...result.value, isMain: false });
    } else if (result.status === "rejected" && !firstError) {
      firstError = result.reason;
    }
  }

  if (firstError) {
    for (const publicId of uploadedPublicIds) {
      await deleteImageFromCloudinary(publicId);
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

  return { images, uploadedPublicIds };
}

async function createProductService(payload, files = []) {
  const {
    type,
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
      409
    );
  }

  const { categoryId, subcategoryName, categoryName } =
    await ensureSubcategoryAndCategory(subcategoryId);
  const brand = await ensureBrandExists(brandId);

  // Resolve brand name for AI context (lightweight query)
  let brandName = null;
  if (brand) {
    const brandDoc = await BrandModel.findById(brand).select("name_en").lean();
    brandName = brandDoc?.name_en || null;
  }

  const normalizedTags = normalizeTags(tags);
  const aiTags = await generateProductTags({
    name_en, name_ar, desc_en, desc_ar,
    subcategoryName, categoryName, brandName,
  });
  const finalTags = mergeTagsWithAI(normalizedTags, aiTags);
  const normalizedOptions =
    normalizedType === productTypeEnum.VARIANT
      ? normalizeProductOptions(options)
      : [];

  let simpleWarehouseStocks = [];
  let simplePrice;
  let simpleDiscountedPrice;

  if (normalizedType === productTypeEnum.SIMPLE) {
    if (!Array.isArray(warehouseStocks) || warehouseStocks.length === 0) {
      throw new ApiError(
        "warehouseStocks is required for SIMPLE products",
        400
      );
    }

    const warehouseIds = warehouseStocks
      .filter((ws) => ws && ws.warehouse)
      .map((ws) => ws.warehouse);

    await ensureWarehousesExist(warehouseIds);

    simpleWarehouseStocks = mapWarehouseStocks(warehouseStocks);
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

    const allWarehouseIds = [];
    for (const v of variants) {
      if (!Array.isArray(v.warehouseStocks) || v.warehouseStocks.length === 0) {
        throw new ApiError(
          "Each variant must have at least one warehouseStocks entry",
          400
        );
      }
      for (const ws of v.warehouseStocks) {
        if (ws && ws.warehouse) {
          allWarehouseIds.push(ws.warehouse);
        }
      }
    }

    await ensureWarehousesExist(allWarehouseIds);
  }

  const { images, uploadedPublicIds } = await uploadProductImages(
    files,
    normalizedSlug,
    mainImageIndex
  );

  if (normalizedType === productTypeEnum.VARIANT) {
    // Map each variant to a single image (if provided) by referencing
    // the already-uploaded product images array. This avoids duplicate
    // uploads while still giving each variant its own images field.
    variantDocs = mapVariantPayloads(variants, images);
  }

  try {
    const product = await createProduct({
      slug: normalizedSlug,
      type: normalizedType,
      subcategory: subcategoryId,
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

    return product;
  } catch (err) {
    for (const publicId of uploadedPublicIds) {
      await deleteImageFromCloudinary(publicId);
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

  let subcategoryName = null;
  let categoryName = null;

  if (subcategoryId !== undefined) {
    const resolved = await ensureSubcategoryAndCategory(subcategoryId);
    product.subcategory = subcategoryId;
    product.category = resolved.categoryId;
    subcategoryName = resolved.subcategoryName;
    categoryName = resolved.categoryName;
  }

  let brandName = null;
  if (brandId !== undefined) {
    if (brandId === null || brandId === "") {
      product.brand = undefined;
    } else {
      const brand = await ensureBrandExists(brandId);
      product.brand = brand;
      const brandDoc = await BrandModel.findById(brand).select("name_en").lean();
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
    const adminTags = tags !== undefined ? normalizeTags(tags) : (product.tags || []);

    // Resolve names for AI context if not already available from above
    if (!subcategoryName && product.subcategory) {
      const resolved = await ensureSubcategoryAndCategory(product.subcategory);
      subcategoryName = resolved.subcategoryName;
      categoryName = resolved.categoryName;
    }
    if (!brandName && product.brand) {
      const brandDoc = await BrandModel.findById(product.brand).select("name_en").lean();
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

    product.tags = mergeTagsWithAI(adminTags, aiTags);
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
      if (!Array.isArray(warehouseStocks) || warehouseStocks.length === 0) {
        throw new ApiError(
          "warehouseStocks is required for SIMPLE products",
          400
        );
      }

      const warehouseIds = warehouseStocks
        .filter((ws) => ws && ws.warehouse)
        .map((ws) => ws.warehouse);

      await ensureWarehousesExist(warehouseIds);

      product.warehouseStocks = mapWarehouseStocks(warehouseStocks);
    }
  }

  if (product.type === productTypeEnum.VARIANT && variants !== undefined) {
    if (!Array.isArray(variants) || variants.length === 0) {
      throw new ApiError("variants are required for VARIANT products", 400);
    }

    validateVariantOptionsMatrix(currentVariantOptions, variants);

    const allWarehouseIds = [];
    for (const v of variants) {
      if (!Array.isArray(v.warehouseStocks) || v.warehouseStocks.length === 0) {
        throw new ApiError(
          "Each variant must have at least one warehouseStocks entry",
          400
        );
      }
      for (const ws of v.warehouseStocks) {
        if (ws && ws.warehouse) {
          allWarehouseIds.push(ws.warehouse);
        }
      }
    }

    await ensureWarehousesExist(allWarehouseIds);
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

  let newImages = null;
  let newUploadedPublicIds = [];
  const oldPublicIds = Array.isArray(product.images)
    ? product.images
        .map((img) => img.public_id)
        .filter((id) => typeof id === "string" && id.length > 0)
    : [];

  if (Array.isArray(files) && files.length > 0) {
    const uploadResult = await uploadProductImages(
      files,
      product.slug,
      mainImageIndex
    );
    newImages = uploadResult.images;
    newUploadedPublicIds = uploadResult.uploadedPublicIds;
    product.images = newImages;
  }

  if (
    product.type === productTypeEnum.VARIANT &&
    shouldRemapVariantsFromPayload
  ) {
    const effectiveImages = Array.isArray(product.images) ? product.images : [];
    const existingVariantsById = new Map(
      Array.isArray(product.variants)
        ? product.variants.map((v) => [String(v._id), v])
        : []
    );
    // Replace the entire variants array with the payload, preserving _id when
    // the payload includes an existing variant _id. Variants omitted from the
    // payload are treated as removed.
    product.variants = mapVariantPayloads(
      variants,
      effectiveImages,
      existingVariantsById
    );
  }

  try {
    const updated = await product.save();

    // Only attempt to delete old images from Cloudinary when we actually
    // uploaded new ones for this product. If no new images were uploaded
    // (files.length === 0), we keep the existing images as-is to avoid
    // unnecessary network calls and accidental deletions.
    if (
      Array.isArray(newUploadedPublicIds) &&
      newUploadedPublicIds.length > 0
    ) {
      for (const publicId of oldPublicIds) {
        if (!newUploadedPublicIds.includes(publicId)) {
          await deleteImageFromCloudinary(publicId);
        }
      }
    }

    // Invalidate cache for both languages
    await deleteCacheKey(`product:${id}:en`);
    await deleteCacheKey(`product:${id}:ar`);

    return updated;
  } catch (err) {
    for (const publicId of newUploadedPublicIds) {
      await deleteImageFromCloudinary(publicId);
    }
    throw err;
  }
}

async function deleteProductService(id) {
  const product = await findProductById(id);
  if (!product) {
    throw new ApiError(`No product found for this id: ${id}`, 404);
  }

  const publicIds = [];

  if (Array.isArray(product.images)) {
    for (const img of product.images) {
      if (img && img.public_id) {
        publicIds.push(img.public_id);
      }
    }
  }

  if (Array.isArray(product.variants)) {
    for (const v of product.variants) {
      if (Array.isArray(v.images)) {
        for (const img of v.images) {
          if (img && img.public_id) {
            publicIds.push(img.public_id);
          }
        }
      }
    }
  }

  for (const publicId of publicIds) {
    await deleteImageFromCloudinary(publicId);
  }

  await deleteProductById(id);

  // Invalidate cache for both languages
  await deleteCacheKey(`product:${id}:en`);
  await deleteCacheKey(`product:${id}:ar`);
}
