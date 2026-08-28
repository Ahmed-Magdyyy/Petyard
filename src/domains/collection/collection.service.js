import slugify from "slugify";
import { ApiError } from "../../shared/utils/ApiError.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import {
  validateImageFile,
  uploadImage,
  deleteImage,
  IMAGE_UPLOAD_PROFILES,
  IMAGE_VISIBILITY,
} from "../../shared/utils/imageUpload.js";
import {
  bumpCacheVersion,
  getCacheVersion,
  getOrSetCache,
  stableStringify,
} from "../../shared/utils/cache.js";
import { parseBoundedInt } from "../../shared/utils/env.js";
import { CollectionModel } from "./collection.model.js";
import {
  autoHideExpiredCollections,
  ensurePromotionalCollectionUniqueness,
} from "./collection.promotion.js";
import { getProductsService } from "../product/product.service.js";
import { bumpProductListCacheVersion } from "../product/productCache.service.js";
import { enabledControls, roles } from "../../shared/constants/enums.js";

const COLLECTION_CACHE_VERSION_KEY = "collections:version";
const COLLECTION_CACHE_TTL_SECONDS = parseBoundedInt(
  process.env.COLLECTION_CACHE_TTL_SECONDS,
  60,
  5,
  10 * 60,
);

async function invalidateCollectionCaches({ affectsProductList = true } = {}) {
  await Promise.all([
    bumpCacheVersion(COLLECTION_CACHE_VERSION_KEY),
    affectsProductList ? bumpProductListCacheVersion() : Promise.resolve(),
  ]);
}

function parseJsonField(value, fieldName) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new ApiError(`${fieldName} must be a valid JSON object`, 400);
  }
}

function parseBooleanField(value) {
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function normalizePromotionObject(promotion) {
  if (!promotion || typeof promotion !== "object") return promotion;

  const normalized = { ...promotion };

  if (normalized.enabled !== undefined) {
    normalized.enabled = parseBooleanField(normalized.enabled);
  }

  if (normalized.isActive !== undefined) {
    normalized.isActive = parseBooleanField(normalized.isActive);
  }

  if (normalized.discountPercent != null) {
    normalized.discountPercent = Number(normalized.discountPercent);
  }

  if (normalized.startsAt != null) {
    normalized.startsAt = new Date(normalized.startsAt);
  }

  if (normalized.endsAt != null) {
    normalized.endsAt = new Date(normalized.endsAt);
  }

  return normalized;
}

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
}

function mapCollectionToPublicDto(
  c,
  lang,
  { includeAllLanguages = false } = {},
) {
  return {
    id: c._id,
    slug: c.slug,
    ...(includeAllLanguages
      ? {
          name: pickLocalizedField(c, "name", lang),
          name_en: c.name_en,
          name_ar: c.name_ar,
          desc: pickLocalizedField(c, "desc", lang),
          desc_en: c.desc_en,
          desc_ar: c.desc_ar,
          isVisible: c.isVisible,
        }
      : {
          name: pickLocalizedField(c, "name", lang),
          desc: pickLocalizedField(c, "desc", lang),
        }),
    selector: c.selector,
    image: c.image?.url || null,
    position: c.position,
    promotion: c.promotion || null,
    updatedAt: c.updatedAt,
  };
}

export async function getCollectionsService(
  queryParams = {},
  lang = "en",
  user = null,
) {
  const normalizedLang = normalizeLang(lang);

  const includeAllCollections =
    user &&
    (user.role === roles.SUPER_ADMIN ||
      (user.role === roles.ADMIN &&
        user.enabledControls?.includes(enabledControls.COLLECTIONS)));

  const isVisibleFilter = parseBooleanField(queryParams?.isVisible);
  const filter = includeAllCollections ? {} : { isVisible: true };

  if (
    includeAllCollections &&
    (isVisibleFilter === true || isVisibleFilter === false)
  ) {
    filter.isVisible = isVisibleFilter;
  }

  const fetchCollections = async () => {
    if (!includeAllCollections) {
      await autoHideExpiredCollections();
    }

    const collections = await CollectionModel.find(filter).sort({
      position: 1,
      slug: 1,
    });

    return collections.map((c) =>
      mapCollectionToPublicDto(c, normalizedLang, {
        includeAllLanguages: includeAllCollections,
      }),
    );
  };

  if (includeAllCollections) {
    return fetchCollections();
  }

  const version = await getCacheVersion(COLLECTION_CACHE_VERSION_KEY);
  return getOrSetCache(
    `collections:list:v1:${version}:${normalizedLang}:${stableStringify(queryParams || {})}`,
    COLLECTION_CACHE_TTL_SECONDS,
    fetchCollections,
  );
}

export async function getCollectionByIdService(id, lang = "en", user = null) {
  const normalizedLang = normalizeLang(lang);

  const includeAllCollections =
    user &&
    (user.role === roles.SUPER_ADMIN ||
      (user.role === roles.ADMIN &&
        user.enabledControls?.includes(enabledControls.COLLECTIONS)));

  const fetchCollection = async () => {
    if (!includeAllCollections) {
      await autoHideExpiredCollections();
    }

    let collection;

    if (includeAllCollections) {
      collection = await CollectionModel.findOne({ _id: id })
        .populate({
          path: "selector.productIds",
          select: "name_en name_ar",
        })
        .populate({
          path: "selector.subcategoryIds",
          select: "name_en name_ar",
        })
        .populate({
          path: "selector.brandIds",
          select: "name_en name_ar",
        });
    } else {
      collection = await CollectionModel.findOne({ _id: id, isVisible: true });
    }
    if (!collection) {
      throw new ApiError(`No collection found for this id: ${id}`, 404);
    }

    return mapCollectionToPublicDto(collection, normalizedLang, {
      includeAllLanguages: includeAllCollections,
    });
  };

  if (includeAllCollections) {
    return fetchCollection();
  }

  const version = await getCacheVersion(COLLECTION_CACHE_VERSION_KEY);
  return getOrSetCache(
    `collections:detail:v1:${version}:${id}:${normalizedLang}`,
    COLLECTION_CACHE_TTL_SECONDS,
    fetchCollection,
  );
}

export async function getCollectionWithProductsService(
  id,
  queryParams = {},
  lang = "en",
  user = null,
) {
  const collection = await getCollectionByIdService(id, lang, user);
  const products = await getProductsService(
    { ...queryParams, collection: id },
    lang,
    {
      onlyActive: true,
      includeZeroStockInWarehouse: true,
      prioritizeInStock: true,
    },
  );
  return { collection, products };
}

export async function createCollectionService(payload, file) {
  const {
    name_en,
    name_ar,
    desc_en,
    desc_ar,
    isVisible,
    position,
    selector,
    promotion,
  } = payload;

  const normalizedSelector = parseJsonField(selector, "selector");
  const normalizedPromotion = normalizePromotionObject(
    parseJsonField(promotion, "promotion"),
  );

  const normalizedSlug = slugify(String(name_en), {
    lower: true,
    strict: true,
    trim: true,
  });

  if (!normalizedSlug) {
    throw new ApiError("Unable to generate slug from name_en", 400);
  }

  const existing = await CollectionModel.findOne({ slug: normalizedSlug });
  if (existing) {
    throw new ApiError(
      `Collection with slug '${normalizedSlug}' already exists`,
      409,
    );
  }

  let image;
  let uploadedImage;

  if (file) {
    validateImageFile(file);
    image = await uploadImage(file, {
      folder: "petyard/collections",
      publicId: `collection_${normalizedSlug}_${Date.now()}`,
      visibility: IMAGE_VISIBILITY.PUBLIC,
      profile: IMAGE_UPLOAD_PROFILES.STANDARD,
    });
    uploadedImage = image;
  }

  try {
    await ensurePromotionalCollectionUniqueness({
      selector: normalizedSelector,
      promotion: normalizedPromotion,
    });

    const collection = await CollectionModel.create({
      slug: normalizedSlug,
      name_en,
      name_ar,
      desc_en,
      desc_ar,
      ...(parseBooleanField(isVisible) !== undefined && {
        isVisible: parseBooleanField(isVisible),
      }),
      ...(position != null && { position: Number(position) || 0 }),
      ...(normalizedSelector && { selector: normalizedSelector }),
      ...(normalizedPromotion && { promotion: normalizedPromotion }),
      ...(image && { image }),
    });

    await invalidateCollectionCaches();

    return collection;
  } catch (err) {
    if (uploadedImage) {
      await deleteImage(uploadedImage);
    }
    throw err;
  }
}

export async function updateCollectionService(id, payload, file) {
  const collection = await CollectionModel.findById(id);
  if (!collection) {
    throw new ApiError(`No collection found for this id: ${id}`, 404);
  }

  const {
    name_en,
    name_ar,
    desc_en,
    desc_ar,
    isVisible,
    position,
    selector,
    promotion,
  } = payload;

  const normalizedSelector = parseJsonField(selector, "selector");
  const normalizedPromotion = normalizePromotionObject(
    parseJsonField(promotion, "promotion"),
  );

  const nextSelector =
    normalizedSelector !== undefined ? normalizedSelector : collection.selector;
  const nextPromotion =
    normalizedPromotion !== undefined
      ? normalizedPromotion
      : collection.promotion;

  await ensurePromotionalCollectionUniqueness({
    collectionId: collection._id,
    selector: nextSelector,
    promotion: nextPromotion,
  });

  if (name_en !== undefined) collection.name_en = name_en;
  if (name_ar !== undefined) collection.name_ar = name_ar;
  if (desc_en !== undefined) collection.desc_en = desc_en;
  if (desc_ar !== undefined) collection.desc_ar = desc_ar;
  if (parseBooleanField(isVisible) !== undefined)
    collection.isVisible = parseBooleanField(isVisible);
  if (position !== undefined) collection.position = Number(position) || 0;
  if (normalizedSelector !== undefined)
    collection.selector = normalizedSelector;
  if (normalizedPromotion !== undefined)
    collection.promotion = normalizedPromotion;

  let newImage;
  let oldImage;

  if (file) {
    validateImageFile(file);
    oldImage = collection.image
      ? { public_id: collection.image.public_id, url: collection.image.url }
      : null;
    newImage = await uploadImage(file, {
      folder: "petyard/collections",
      publicId: `collection_${collection.slug}_${Date.now()}`,
      visibility: IMAGE_VISIBILITY.PUBLIC,
      profile: IMAGE_UPLOAD_PROFILES.STANDARD,
    });
    collection.image = newImage;
  }

  try {
    const updated = await collection.save();

    if (oldImage) {
      await deleteImage(oldImage);
    }

    await invalidateCollectionCaches();

    return updated;
  } catch (err) {
    if (newImage) {
      await deleteImage(newImage);
    }
    throw err;
  }
}

export async function deleteCollectionService(id) {
  const collection = await CollectionModel.findById(id);
  if (!collection) {
    throw new ApiError(`No collection found for this id: ${id}`, 404);
  }

  if (collection.image?.url) {
    await deleteImage(collection.image);
  }

  await CollectionModel.deleteOne({ _id: id });
  await invalidateCollectionCaches();
}

export async function updateCollectionPositionsService(positions) {
  const ops = positions.map(({ id, position }) => ({
    updateOne: {
      filter: { _id: id },
      update: { $set: { position: Number(position) } },
    },
  }));

  const result = await CollectionModel.bulkWrite(ops, { ordered: false });
  await invalidateCollectionCaches({ affectsProductList: false });
  return {
    requested: positions.length,
    matched: result.matchedCount,
    modified: result.modifiedCount,
  };
}
