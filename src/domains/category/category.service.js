import { CategoryModel } from "./category.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import slugify from "slugify";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import {
  validateImageFile,
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
} from "../../shared/utils/imageUpload.js";

export async function getCategoriesService(lang = "en") {
  const normalizedLang = lang === "ar" ? "ar" : "en";

  const categories = await CategoryModel.find({}).sort({ slug: 1 });

  return categories.map((c) => ({
    id: c._id,
    slug: c.slug,
    name: pickLocalizedField(c, "name", normalizedLang),
    desc: pickLocalizedField(c, "desc", normalizedLang),
    image: c.image || null,
  }));
}

export async function getCategoryByIdService(id, lang = "en") {
  const normalizedLang = lang === "ar" ? "ar" : "en";

  const category = await CategoryModel.findById(id);
  if (!category) {
    throw new ApiError(`No category found for this id: ${id}`, 404);
  }

  return {
    id: category._id,
    slug: category.slug,
    name: pickLocalizedField(category, "name", normalizedLang),
    desc: pickLocalizedField(category, "desc", normalizedLang),
    image: category.image.url || null,
  };
}

export async function createCategoryService(payload, file) {
  const { name_en, name_ar, desc_en, desc_ar } = payload;

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
    throw new ApiError(`Category with slug '${normalizedSlug}' already exists`, 409);
  }

  let image;
  let uploadedPublicId;

  if (file) {
    validateImageFile(file);
    image = await uploadImageToCloudinary(file, {
      folder: "petyard/categories",
      publicId: `category_${normalizedSlug}_${Date.now()}`,
    });
    uploadedPublicId = image?.public_id;
  }

  try {
    const category = await CategoryModel.create({
      slug: normalizedSlug,
      name_en,
      name_ar,
      desc_en,
      desc_ar,
      ...(image && { image }),
    });

    return category;
  } catch (err) {
    if (uploadedPublicId) {
      await deleteImageFromCloudinary(uploadedPublicId);
    }
    throw err;
  }
}

export async function updateCategoryService(id, payload, file) {
  const category = await CategoryModel.findById(id);
  if (!category) {
    throw new ApiError(`No category found for this id: ${id}`, 404);
  }

  const { name_en, name_ar, desc_en, desc_ar } = payload;

  if (name_en !== undefined) category.name_en = name_en;
  if (name_ar !== undefined) category.name_ar = name_ar;
  if (desc_en !== undefined) category.desc_en = desc_en;
  if (desc_ar !== undefined) category.desc_ar = desc_ar;

  let newImage;
  let oldPublicId;

  if (file) {
    validateImageFile(file);
    oldPublicId = category.image?.public_id;
    newImage = await uploadImageToCloudinary(file, {
      folder: "petyard/categories",
      publicId: `category_${category.slug}_${Date.now()}`,
    });
    category.image = newImage;
  }

  try {
    const updated = await category.save();

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

export async function deleteCategoryService(id) {
  const category = await CategoryModel.findById(id);
  if (!category) {
    throw new ApiError(`No category found for this id: ${id}`, 404);
  }

  if (category.image?.public_id) {
    await deleteImageFromCloudinary(category.image.public_id);
  }

  await CategoryModel.deleteOne({ _id: id });
}
