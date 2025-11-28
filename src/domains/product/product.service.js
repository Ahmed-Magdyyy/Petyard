import { ProductModel } from "./product.model.js";
import { SubcategoryModel } from "../subcategory/subcategory.model.js";
import { BrandModel } from "../brand/brand.model.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { ApiError } from "../../shared/ApiError.js";
import slugify from "slugify";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
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
import { getOrSetCache, deleteCacheKey } from "../../shared/cache.js";

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
}

function normalizeTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) {
    return tags
      .map((t) => (typeof t === "string" ? t.trim() : ""))
      .filter(Boolean);
  }
  if (typeof tags === "string") {
    return tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
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

    if (!variant || !Array.isArray(variant.options) || variant.options.length === 0) {
      throw new ApiError(
        `Variant #${label} must define options for all product options: ${optionNames.join(", ")}`,
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

    const missingNames = optionNames.filter((name) => !variantOptionsMap.has(name));
    const extraNames = [...variantOptionsMap.keys()].filter(
      (name) => !optionNames.includes(name)
    );

    if (missingNames.length || extraNames.length) {
      if (missingNames.length) {
        throw new ApiError(
          `Variant #${label} is missing options: ${missingNames.join(", ")}. Each variant must specify all product options: ${optionNames.join(", ")}`,
          400
        );
      }

      if (extraNames.length) {
        throw new ApiError(
          `Variant #${label} has unknown options: ${extraNames.join(", ")}. Valid option names are: ${optionNames.join(", ")}`,
          400
        );
      }
    }

    for (const optDef of optionDefs) {
      const value = variantOptionsMap.get(optDef.name);
      if (!optDef.values.includes(value)) {
        throw new ApiError(
          `Variant #${label} has invalid value '${value}' for option '${optDef.name}'. Allowed values: ${optDef.values.join(", ")}`,
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

export async function getProductsService(queryParams = {}) {
  const {
    page,
    limit,
    lang,
    sortKey,
    q,
    category,
    subcategory,
    brand,
    warehouse,
    type,
    isFeatured,
    isActive,
    ...rest
  } = queryParams;

  const normalizedLang = normalizeLang(lang);

  const filter = {};

  // Type filter (SIMPLE vs VARIANT)
  if (type && ["SIMPLE", "VARIANT"].includes(type)) {
    filter.type = type;
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

  // Optional warehouse filter: only include products that have stock > 0
  // in the given warehouse. This applies to both SIMPLE and VARIANT products.
  let warehouseFilter = null;
  if (warehouse) {
    const warehouseId = Array.isArray(warehouse)
      ? String(warehouse[0])
      : String(warehouse);

    if (warehouseId) {
      if (filter.type === "SIMPLE") {
        warehouseFilter = {
          "warehouseStocks.warehouse": warehouseId,
          "warehouseStocks.quantity": { $gt: 0 },
        };
      } else if (filter.type === "VARIANT") {
        warehouseFilter = {
          "variants.warehouseStocks.warehouse": warehouseId,
          "variants.warehouseStocks.quantity": { $gt: 0 },
        };
      } else {
        warehouseFilter = {
          $or: [
            {
              type: "SIMPLE",
              "warehouseStocks.warehouse": warehouseId,
              "warehouseStocks.quantity": { $gt: 0 },
            },
            {
              type: "VARIANT",
              "variants.warehouseStocks.warehouse": warehouseId,
              "variants.warehouseStocks.quantity": { $gt: 0 },
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

  const totalProductsCount = await ProductModel.countDocuments(mongoFilter);

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 10);

  let sort = mapProductSortKey(sortKey);
  if (!sort) {
    sort = buildSort(queryParams, "-createdAt");
  }

  const productsQuery = ProductModel.find(mongoFilter)
    .populate("category", "_id slug name_en name_ar")
    .populate("subcategory", "_id slug name_en name_ar")
    .populate("brand", "_id slug name_en name_ar")
    .skip(skip)
    .limit(limitNum);

  if (sort) {
    productsQuery.sort(sort);
  }

  const products = await productsQuery;

  const data = products.map((p) => {
    const mainImage = pickMainImage(p.images);

    let stock = 0;
    if (p.type === "SIMPLE") {
      stock = computeTotalStockForSimple(p);
    } else if (p.type === "VARIANT") {
      stock = computeTotalStockForVariants(p);
    }

    let effectivePrice = p.price;
    let effectiveDiscountedPrice = p.discountedPrice;

    if (
      p.type === "VARIANT" &&
      Array.isArray(p.variants) &&
      p.variants.length > 0
    ) {
      let minPrice = Infinity;
      let minDiscounted = undefined;

      for (const v of p.variants) {
        if (typeof v.price === "number" && v.price < minPrice) {
          minPrice = v.price;
          minDiscounted =
            typeof v.discountedPrice === "number"
              ? v.discountedPrice
              : undefined;
        }
      }

      if (minPrice !== Infinity) {
        effectivePrice = minPrice;
        if (minDiscounted !== undefined) {
          effectiveDiscountedPrice = minDiscounted;
        }
      }
    }

    const category = mapLocalizedRef(p.category, normalizedLang);
    const subcategory = mapLocalizedRef(p.subcategory, normalizedLang);
    const brand = mapLocalizedRef(p.brand, normalizedLang);

    return {
      id: p._id,
      slug: p.slug,
      type: p.type,
      category,
      subcategory,
      brand,
      name: pickLocalizedField(p, "name", normalizedLang),
      desc: pickLocalizedField(p, "desc", normalizedLang),
      tags: p.tags || [],
      price: typeof effectivePrice === "number" ? effectivePrice : null,
      discountedPrice:
        typeof effectiveDiscountedPrice === "number"
          ? effectiveDiscountedPrice
          : null,
      stock,
      inStock: stock > 0,
      image: mainImage?.url || null,
      hasVariants:
        p.type === "VARIANT" &&
        Array.isArray(p.variants) &&
        p.variants.length > 0,
    };
  });

  const totalPages = Math.ceil(totalProductsCount / limitNum) || 1;

  return {
    totalPages,
    page: pageNum,
    results: data.length,
    data,
  };
}

export async function getProductByIdService(id, query = {}) {
  const { lang } = query;
  const normalizedLang = normalizeLang(lang);
  const cacheKey = `product:${id}:${normalizedLang}`;

  return getOrSetCache(cacheKey, 3600, async () => {
    const product = await ProductModel.findById(id)
      .populate("category", "_id slug name_en name_ar")
      .populate("subcategory", "_id slug name_en name_ar")
      .populate("brand", "_id slug name_en name_ar");

    if (!product) {
      throw new ApiError(`No product found for this id: ${id}`, 404);
    }

    const mainImage = pickMainImage(product.images);

    let stock = 0;
    if (product.type === "SIMPLE") {
      stock = computeTotalStockForSimple(product);
    } else if (product.type === "VARIANT") {
      stock = computeTotalStockForVariants(product);
    }

    const images = Array.isArray(product.images)
      ? product.images.map((img) => ({
          public_id: img.public_id,
          url: img.url,
          isMain: !!img.isMain,
        }))
      : [];

    const variants =
      product.type === "VARIANT" &&
      Array.isArray(product.variants) &&
      product.variants.length > 0
        ? product.variants.map((v, index) => ({
            index,
            sku: v.sku || null,
            price: v.price,
            discountedPrice:
              typeof v.discountedPrice === "number" ? v.discountedPrice : null,
            options: Array.isArray(v.options) ? v.options : [],
            images: Array.isArray(v.images)
              ? v.images.map((img) => ({
                  public_id: img.public_id,
                  url: img.url,
                  isMain: !!img.isMain,
                }))
              : [],
            warehouseStocks: Array.isArray(v.warehouseStocks)
              ? v.warehouseStocks.map((ws) => ({
                  warehouse: ws.warehouse,
                  quantity: ws.quantity,
                }))
              : [],
            isDefault: !!v.isDefault,
          }))
        : undefined;

    const warehouseStocks =
      product.type === "SIMPLE" && Array.isArray(product.warehouseStocks)
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
      name: pickLocalizedField(product, "name", normalizedLang),
      desc: pickLocalizedField(product, "desc", normalizedLang),
      sku: product.sku || null,
      tags: product.tags || [],
      price: typeof product.price === "number" ? product.price : null,
      discountedPrice:
        typeof product.discountedPrice === "number"
          ? product.discountedPrice
          : null,
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
    };
  });
}

async function ensureSubcategoryAndCategory(subcategoryId) {
  const subcategory = await SubcategoryModel.findById(subcategoryId).select(
    "category"
  );
  if (!subcategory) {
    throw new ApiError(
      `No subcategory found for this id: ${subcategoryId}`,
      400
    );
  }
  if (!subcategory.category) {
    throw new ApiError(
      `Subcategory with id ${subcategoryId} does not have a linked category`,
      500
    );
  }
  return { subcategoryId, categoryId: subcategory.category };
}

async function ensureBrandExists(brandId) {
  if (!brandId) return null;
  const exists = await BrandModel.exists({ _id: brandId });
  if (!exists) {
    throw new ApiError(`No brand found for this id: ${brandId}`, 400);
  }
  return brandId;
}

async function ensureWarehousesExist(warehouseIds) {
  const uniqueIds = Array.from(new Set(warehouseIds.map((id) => String(id))));
  if (uniqueIds.length === 0) return;

  const count = await WarehouseModel.countDocuments({
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

function mapVariantPayloads(rawVariants) {
  if (!Array.isArray(rawVariants)) return [];
  return rawVariants.map((v) => ({
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
    isDefault: !!v.isDefault,
  }));
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

export async function createProductService(payload, files = []) {
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

  const normalizedSlug = slugify(String(name_en), {
    lower: true,
    strict: true,
    trim: true,
  });

  if (!normalizedSlug) {
    throw new ApiError("Unable to generate slug from name_en", 400);
  }

  const existing = await ProductModel.findOne({ slug: normalizedSlug });
  if (existing) {
    throw new ApiError(
      `Product with slug '${normalizedSlug}' already exists`,
      409
    );
  }

  const { categoryId } = await ensureSubcategoryAndCategory(subcategoryId);
  const brand = await ensureBrandExists(brandId);
  const normalizedTags = normalizeTags(tags);
  const normalizedOptions =
    type === "VARIANT" ? normalizeProductOptions(options) : [];

  let simpleWarehouseStocks = [];
  let simplePrice;
  let simpleDiscountedPrice;

  if (type === "SIMPLE") {
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
  if (type === "VARIANT") {
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

    variantDocs = mapVariantPayloads(variants);
  }

  const { images, uploadedPublicIds } = await uploadProductImages(
    files,
    normalizedSlug,
    mainImageIndex
  );

  try {
    const product = await ProductModel.create({
      slug: normalizedSlug,
      type,
      subcategory: subcategoryId,
      category: categoryId,
      ...(brand && { brand }),
      name_en,
      name_ar,
      desc_en,
      desc_ar,
      sku,
      tags: normalizedTags,
      price: type === "SIMPLE" ? simplePrice : undefined,
      discountedPrice: type === "SIMPLE" ? simpleDiscountedPrice : undefined,
      warehouseStocks: type === "SIMPLE" ? simpleWarehouseStocks : [],
      images,
      options: normalizedOptions,
      variants: type === "VARIANT" ? variantDocs : [],
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

export async function updateProductService(id, payload, files = []) {
  const product = await ProductModel.findById(id);
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

  if (subcategoryId !== undefined) {
    const { categoryId } = await ensureSubcategoryAndCategory(subcategoryId);
    product.subcategory = subcategoryId;
    product.category = categoryId;
  }

  if (brandId !== undefined) {
    if (brandId === null || brandId === "") {
      product.brand = undefined;
    } else {
      const brand = await ensureBrandExists(brandId);
      product.brand = brand;
    }
  }

  if (name_en !== undefined) product.name_en = name_en;
  if (name_ar !== undefined) product.name_ar = name_ar;
  if (desc_en !== undefined) product.desc_en = desc_en;
  if (desc_ar !== undefined) product.desc_ar = desc_ar;

  if (sku !== undefined) product.sku = sku;

  if (tags !== undefined) {
    product.tags = normalizeTags(tags);
  }

  if (options !== undefined) {
    if (product.type === "SIMPLE") {
      throw new ApiError("options cannot be set for SIMPLE products", 400);
    }
    product.options = normalizeProductOptions(options);
  }

  const currentVariantOptions =
    product.type === "VARIANT" ? normalizeProductOptions(product.options || []) : [];

  if (product.type === "SIMPLE") {
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

  if (product.type === "VARIANT" && variants !== undefined) {
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

    product.variants = mapVariantPayloads(variants);
  } else if (product.type === "VARIANT" && variants === undefined && options !== undefined) {
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

  try {
    const updated = await product.save();

    for (const publicId of oldPublicIds) {
      if (!newUploadedPublicIds.includes(publicId)) {
        await deleteImageFromCloudinary(publicId);
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

export async function deleteProductService(id) {
  const product = await ProductModel.findById(id);
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

  await ProductModel.deleteOne({ _id: id });

  // Invalidate cache for both languages
  await deleteCacheKey(`product:${id}:en`);
  await deleteCacheKey(`product:${id}:ar`);
}
