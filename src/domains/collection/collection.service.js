import slugify from "slugify";
import { ApiError } from "../../shared/utils/ApiError.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import {
  validateImageFile,
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
} from "../../shared/utils/imageUpload.js";
import { CollectionModel } from "./collection.model.js";
import {
  autoHideExpiredCollections,
  ensurePromotionalCollectionUniqueness,
} from "./collection.promotion.js";
import { getProductsService } from "../product/product.service.js";

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

function mapCollectionToPublicDto(c, lang) {
  return {
    id: c._id,
    slug: c.slug,
    name: pickLocalizedField(c, "name", lang),
    desc: pickLocalizedField(c, "desc", lang),
    image: c.image?.url || null,
    position: c.position,
    promotion: c.promotion || null,
  };
}

export async function getCollectionsService(lang = "en") {
  const normalizedLang = normalizeLang(lang);

  await autoHideExpiredCollections();

  const collections = await CollectionModel.find({ isVisible: true }).sort({
    position: 1,
    slug: 1,
  });

  return collections.map((c) => mapCollectionToPublicDto(c, normalizedLang));
}

export async function getCollectionByIdService(id, lang = "en") {
  const normalizedLang = normalizeLang(lang);

  await autoHideExpiredCollections();

  const collection = await CollectionModel.findOne({ _id: id, isVisible: true });
  if (!collection) {
    throw new ApiError(`No collection found for this id: ${id}`, 404);
  }

  return mapCollectionToPublicDto(collection, normalizedLang);
}

export async function getCollectionWithProductsService(
  id,
  queryParams = {},
  lang = "en"
) {
  const collection = await getCollectionByIdService(id, lang);
  const products = await getProductsService({ ...queryParams, collection: id }, lang);
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
    parseJsonField(promotion, "promotion")
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
    throw new ApiError(`Collection with slug '${normalizedSlug}' already exists`, 409);
  }

  let image;
  let uploadedPublicId;

  if (file) {
    validateImageFile(file);
    image = await uploadImageToCloudinary(file, {
      folder: "petyard/collections",
      publicId: `collection_${normalizedSlug}_${Date.now()}`,
    });
    uploadedPublicId = image?.public_id;
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

    return collection;
  } catch (err) {
    if (uploadedPublicId) {
      await deleteImageFromCloudinary(uploadedPublicId);
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
    parseJsonField(promotion, "promotion")
  );

  const nextSelector =
    normalizedSelector !== undefined ? normalizedSelector : collection.selector;
  const nextPromotion =
    normalizedPromotion !== undefined ? normalizedPromotion : collection.promotion;

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
  if (normalizedSelector !== undefined) collection.selector = normalizedSelector;
  if (normalizedPromotion !== undefined) collection.promotion = normalizedPromotion;

  let newImage;
  let oldPublicId;

  if (file) {
    validateImageFile(file);
    oldPublicId = collection.image?.public_id;
    newImage = await uploadImageToCloudinary(file, {
      folder: "petyard/collections",
      publicId: `collection_${collection.slug}_${Date.now()}`,
    });
    collection.image = newImage;
  }

  try {
    const updated = await collection.save();

    if (oldPublicId) {
      await deleteImageFromCloudinary(oldPublicId);
    }

    return updated;
  } catch (err) {
    if (newImage?.public_id) {
      await deleteImageFromCloudinary(newImage.public_id);
    }
    throw err;
  }
}

export async function deleteCollectionService(id) {
  const collection = await CollectionModel.findById(id);
  if (!collection) {
    throw new ApiError(`No collection found for this id: ${id}`, 404);
  }

  if (collection.image?.public_id) {
    await deleteImageFromCloudinary(collection.image.public_id);
  }

  await CollectionModel.deleteOne({ _id: id });
}
