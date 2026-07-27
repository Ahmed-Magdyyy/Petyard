import { CategoryModel } from "./category.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import slugify from "slugify";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import { enabledControls, roles } from "../../shared/constants/enums.js";
import {
  bumpCacheVersion,
  getCacheVersion,
  getOrSetCache,
} from "../../shared/utils/cache.js";
import { parseBoundedInt } from "../../shared/utils/env.js";
import {
  IMAGE_DELIVERY_CACHE_NAMESPACE,
  IMAGE_DELIVERY_PRESETS,
  getImageDeliveryUrl,
  getImageObjectWithDeliveryUrl,
} from "../../shared/utils/imageDelivery.js";
import { bumpProductListCacheVersion } from "../product/productCache.service.js";
import {
  validateImageFile,
  uploadImage,
  deleteImage,
  IMAGE_UPLOAD_PROFILES,
  IMAGE_VISIBILITY,
} from "../../shared/utils/imageUpload.js";

const CATEGORY_CACHE_VERSION_KEY = "categories:version";
const CATEGORY_CACHE_TTL_SECONDS = parseBoundedInt(
  process.env.CATEGORY_CACHE_TTL_SECONDS,
  5 * 60,
  5,
  60 * 60,
);

async function invalidateCategoryCaches() {
  await Promise.all([
    bumpCacheVersion(CATEGORY_CACHE_VERSION_KEY),
    bumpProductListCacheVersion(),
  ]);
}

export async function getCategoriesService(lang = "en", user = null) {
  const normalizedLang = lang === "ar" ? "ar" : "en";
  const includeAllLanguages =
    user &&
    (user.role === roles.SUPER_ADMIN ||
      (user.role === roles.ADMIN &&
        user.enabledControls?.includes(enabledControls.CATEGORIES)));

  const fetchCategories = async () => {
    const categories = await CategoryModel.find({}).sort({ position: 1 });

    return categories.map((c) => ({
      id: c._id,
      slug: c.slug,
      updatedAt: c.updatedAt,
      ...(includeAllLanguages
        ? {
            name: pickLocalizedField(c, "name", normalizedLang),
            name_en: c.name_en,
            name_ar: c.name_ar,
            desc: pickLocalizedField(c, "desc", normalizedLang),
            desc_en: c.desc_en,
            desc_ar: c.desc_ar,
          }
        : {
            name: pickLocalizedField(c, "name", normalizedLang),
            desc: pickLocalizedField(c, "desc", normalizedLang),
          }),
      image:
        getImageObjectWithDeliveryUrl(
          c.image,
          IMAGE_DELIVERY_PRESETS.CATEGORY_TILE,
        ) || null,
      position: typeof c.position === "number" ? c.position : 0,
    }));
  };

  if (includeAllLanguages) {
    return fetchCategories();
  }

  const version = await getCacheVersion(CATEGORY_CACHE_VERSION_KEY);
  return getOrSetCache(
    `categories:list:v2:${IMAGE_DELIVERY_CACHE_NAMESPACE}:${version}:${normalizedLang}`,
    CATEGORY_CACHE_TTL_SECONDS,
    fetchCategories,
  );
}

export async function getCategoryByIdService(id, lang = "en", user = null) {
  const normalizedLang = lang === "ar" ? "ar" : "en";
  const includeAllLanguages =
    user &&
    (user.role === roles.SUPER_ADMIN ||
      (user.role === roles.ADMIN &&
        user.enabledControls?.includes(enabledControls.CATEGORIES)));

  const fetchCategory = async () => {
    const category = await CategoryModel.findById(id);
    if (!category) {
      throw new ApiError(`No category found for this id: ${id}`, 404);
    }

    return {
      id: category._id,
      slug: category.slug,
      updatedAt: category.updatedAt,
      ...(includeAllLanguages
        ? {
            name: pickLocalizedField(category, "name", normalizedLang),
            name_en: category.name_en,
            name_ar: category.name_ar,
            desc: pickLocalizedField(category, "desc", normalizedLang),
            desc_en: category.desc_en,
            desc_ar: category.desc_ar,
          }
        : {
            name: pickLocalizedField(category, "name", normalizedLang),
            desc: pickLocalizedField(category, "desc", normalizedLang),
          }),
      image: getImageDeliveryUrl(
        category.image?.url || null,
        IMAGE_DELIVERY_PRESETS.CATEGORY_TILE,
      ),
      position: typeof category.position === "number" ? category.position : 0,
    };
  };

  if (includeAllLanguages) {
    return fetchCategory();
  }

  const version = await getCacheVersion(CATEGORY_CACHE_VERSION_KEY);
  return getOrSetCache(
    `categories:detail:v2:${IMAGE_DELIVERY_CACHE_NAMESPACE}:${version}:${id}:${normalizedLang}`,
    CATEGORY_CACHE_TTL_SECONDS,
    fetchCategory,
  );
}

export async function createCategoryService(payload, file) {
  const { name_en, name_ar, desc_en, desc_ar, position } = payload;

  const normalizedSlug = slugify(String(name_en), {
    lower: true,
    strict: true,
    trim: true,
  });

  if (!normalizedSlug) {
    throw new ApiError("Unable to generate slug from name_en", 400);
  }

  const existing = await CategoryModel.findOne({ slug: normalizedSlug });
  if (existing) {
    throw new ApiError(
      `Category with slug '${normalizedSlug}' already exists`,
      409,
    );
  }

  let image;
  let uploadedImage;

  if (file) {
    validateImageFile(file);
    image = await uploadImage(file, {
      folder: "petyard/categories",
      publicId: `category_${normalizedSlug}_${Date.now()}`,
      visibility: IMAGE_VISIBILITY.PUBLIC,
      profile: IMAGE_UPLOAD_PROFILES.TILE,
    });
    uploadedImage = image;
  }

  try {
    const category = await CategoryModel.create({
      slug: normalizedSlug,
      name_en,
      name_ar,
      desc_en,
      desc_ar,
      ...(position != null && { position: Number(position) || 0 }),
      ...(image && { image }),
    });

    await invalidateCategoryCaches();

    return category;
  } catch (err) {
    if (uploadedImage) {
      await deleteImage(uploadedImage);
    }
    throw err;
  }
}

export async function updateCategoryService(id, payload, file) {
  const category = await CategoryModel.findById(id);
  if (!category) {
    throw new ApiError(`No category found for this id: ${id}`, 404);
  }

  const { name_en, name_ar, desc_en, desc_ar, position } = payload;

  if (name_en !== undefined) category.name_en = name_en;
  if (name_ar !== undefined) category.name_ar = name_ar;
  if (desc_en !== undefined) category.desc_en = desc_en;
  if (desc_ar !== undefined) category.desc_ar = desc_ar;
  if (position !== undefined) category.position = Number(position) || 0;

  let newImage;
  let oldImage;

  if (file) {
    validateImageFile(file);
    oldImage = category.image
      ? { public_id: category.image.public_id, url: category.image.url }
      : null;
    newImage = await uploadImage(file, {
      folder: "petyard/categories",
      publicId: `category_${category.slug}_${Date.now()}`,
      visibility: IMAGE_VISIBILITY.PUBLIC,
      profile: IMAGE_UPLOAD_PROFILES.TILE,
    });
    category.image = newImage;
  }

  try {
    const updated = await category.save();

    if (oldImage) {
      await deleteImage(oldImage);
    }

    await invalidateCategoryCaches();

    return updated;
  } catch (err) {
    if (newImage) {
      await deleteImage(newImage);
    }
    throw err;
  }
}

export async function deleteCategoryService(id) {
  const category = await CategoryModel.findById(id);
  if (!category) {
    throw new ApiError(`No category found for this id: ${id}`, 404);
  }

  if (category.image?.url) {
    await deleteImage(category.image);
  }

  await CategoryModel.deleteOne({ _id: id });
  await invalidateCategoryCaches();
}

export async function updateCategoryPositionsService(positions) {
  const ops = positions.map(({ id, position }) => ({
    updateOne: {
      filter: { _id: id },
      update: { $set: { position: Number(position) } },
    },
  }));

  const result = await CategoryModel.bulkWrite(ops, { ordered: false });
  await invalidateCategoryCaches();
  return {
    requested: positions.length,
    matched: result.matchedCount,
    modified: result.modifiedCount,
  };
}
