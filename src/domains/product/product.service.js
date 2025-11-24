import { ProductModel } from "./product.model.js";
import { SubcategoryModel } from "../subcategory/subcategory.model.js";
import { BrandModel } from "../brand/brand.model.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { ApiError } from "../../shared/ApiError.js";
import slugify from "slugify";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import {
  validateImageFile,
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
} from "../../shared/utils/imageUpload.js";

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

export async function getProductsService(query = {}) {
  const { lang, category, subcategory, brand, type } = query;
  const normalizedLang = normalizeLang(lang);

  const filter = {};
  if (category) filter.category = category;
  if (subcategory) filter.subcategory = subcategory;
  if (brand) filter.brand = brand;
  if (type && ["SIMPLE", "VARIANT"].includes(type)) filter.type = type;

  const products = await ProductModel.find(filter)
    .populate("category", "_id slug name_en name_ar")
    .populate("subcategory", "_id slug name_en name_ar")
    .populate("brand", "_id slug name_en name_ar")
    .sort({ slug: 1 });

  return products.map((p) => {
    const mainImage = pickMainImage(p.images);

    let stock = 0;
    if (p.type === "SIMPLE") {
      stock = computeTotalStockForSimple(p);
    } else if (p.type === "VARIANT") {
      stock = computeTotalStockForVariants(p);
    }

    let effectivePrice = p.price;
    let effectiveDiscountedPrice = p.discountedPrice;

    if (p.type === "VARIANT" && Array.isArray(p.variants) && p.variants.length > 0) {
      let minPrice = Infinity;
      let minDiscounted = undefined;

      for (const v of p.variants) {
        if (typeof v.price === "number" && v.price < minPrice) {
          minPrice = v.price;
          minDiscounted =
            typeof v.discountedPrice === "number" ? v.discountedPrice : undefined;
        }
      }

      if (minPrice !== Infinity) {
        effectivePrice = minPrice;
        if (minDiscounted !== undefined) {
          effectiveDiscountedPrice = minDiscounted;
        }
      }
    }

    return {
      id: p._id,
      slug: p.slug,
      type: p.type,
      category: p.category?._id || p.category,
      subcategory: p.subcategory?._id || p.subcategory,
      brand: p.brand?._id || p.brand,
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
        p.type === "VARIANT" && Array.isArray(p.variants) && p.variants.length > 0,
    };
  });
}

export async function getProductByIdService(id, query = {}) {
  const { lang } = query;
  const normalizedLang = normalizeLang(lang);

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
    product.type === "VARIANT" && Array.isArray(product.variants)
      ? product.variants.map((v, index) => ({
          index,
          sku: v.sku || null,
          name_en: v.name_en || null,
          name_ar: v.name_ar || null,
          price: v.price,
          discountedPrice:
            typeof v.discountedPrice === "number" ? v.discountedPrice : null,
          weight: typeof v.weight === "number" ? v.weight : null,
          attributes: Array.isArray(v.attributes) ? v.attributes : [],
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
      : [];

  const warehouseStocks =
    product.type === "SIMPLE" && Array.isArray(product.warehouseStocks)
      ? product.warehouseStocks.map((ws) => ({
          warehouse: ws.warehouse,
          quantity: ws.quantity,
        }))
      : [];

  return {
    id: product._id,
    slug: product.slug,
    type: product.type,
    category: product.category?._id || product.category,
    subcategory: product.subcategory?._id || product.subcategory,
    brand: product.brand?._id || product.brand,
    name: pickLocalizedField(product, "name", normalizedLang),
    desc: pickLocalizedField(product, "desc", normalizedLang),
    sku: product.sku || null,
    weight: typeof product.weight === "number" ? product.weight : null,
    tags: product.tags || [],
    price: typeof product.price === "number" ? product.price : null,
    discountedPrice:
      typeof product.discountedPrice === "number" ? product.discountedPrice : null,
    stock,
    inStock: stock > 0,
    images,
    mainImage: mainImage?.url || null,
    variants,
    warehouseStocks,
  };
}

async function ensureSubcategoryAndCategory(subcategoryId) {
  const subcategory = await SubcategoryModel.findById(subcategoryId).select(
    "category"
  );
  if (!subcategory) {
    throw new ApiError(`No subcategory found for this id: ${subcategoryId}`, 400);
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

  const count = await WarehouseModel.countDocuments({ _id: { $in: uniqueIds } });
  if (count !== uniqueIds.length) {
    throw new ApiError("One or more warehouses do not exist", 400);
  }
}

function mapWarehouseStocks(rawStocks) {
  if (!Array.isArray(rawStocks)) return [];
  return rawStocks.map((ws) => ({
    warehouse: ws.warehouse,
    quantity: typeof ws.quantity === "number" ? ws.quantity : Number(ws.quantity) || 0,
  }));
}

function mapVariantPayloads(rawVariants) {
  if (!Array.isArray(rawVariants)) return [];
  return rawVariants.map((v) => ({
    sku: v.sku,
    name_en: v.name_en,
    name_ar: v.name_ar,
    price: typeof v.price === "number" ? v.price : Number(v.price) || 0,
    discountedPrice:
      typeof v.discountedPrice === "number"
        ? v.discountedPrice
        : v.discountedPrice != null
        ? Number(v.discountedPrice) || 0
        : undefined,
    weight:
      typeof v.weight === "number"
        ? v.weight
        : v.weight != null
        ? Number(v.weight) || 0
        : undefined,
    attributes: Array.isArray(v.attributes)
      ? v.attributes.map((a) => ({
          key: a.key,
          value_en: a.value_en,
          value_ar: a.value_ar,
        }))
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
    weight,
    tags,
    price,
    discountedPrice,
    warehouseStocks,
    variants,
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
    throw new ApiError(`Product with slug '${normalizedSlug}' already exists`, 409);
  }

  const { categoryId } = await ensureSubcategoryAndCategory(subcategoryId);
  const brand = await ensureBrandExists(brandId);
  const normalizedTags = normalizeTags(tags);

  let simpleWarehouseStocks = [];
  let simplePrice;
  let simpleDiscountedPrice;

  if (type === "SIMPLE") {
    if (!Array.isArray(warehouseStocks) || warehouseStocks.length === 0) {
      throw new ApiError("warehouseStocks is required for SIMPLE products", 400);
    }

    const warehouseIds = warehouseStocks
      .filter((ws) => ws && ws.warehouse)
      .map((ws) => ws.warehouse);

    await ensureWarehousesExist(warehouseIds);

    simpleWarehouseStocks = mapWarehouseStocks(warehouseStocks);
    simplePrice =
      typeof price === "number" ? price : price != null ? Number(price) || 0 : 0;

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
      weight:
        typeof weight === "number"
          ? weight
          : weight != null
          ? Number(weight) || 0
          : undefined,
      tags: normalizedTags,
      price: type === "SIMPLE" ? simplePrice : undefined,
      discountedPrice: type === "SIMPLE" ? simpleDiscountedPrice : undefined,
      warehouseStocks: type === "SIMPLE" ? simpleWarehouseStocks : [],
      images,
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
    weight,
    tags,
    price,
    discountedPrice,
    warehouseStocks,
    variants,
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

  if (weight !== undefined) {
    product.weight =
      typeof weight === "number"
        ? weight
        : weight != null
        ? Number(weight) || 0
        : undefined;
  }

  if (tags !== undefined) {
    product.tags = normalizeTags(tags);
  }

  if (product.type === "SIMPLE") {
    if (price !== undefined) {
      product.price =
        typeof price === "number" ? price : price != null ? Number(price) || 0 : 0;
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
    const uploadResult = await uploadProductImages(files, product.slug, mainImageIndex);
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
}
