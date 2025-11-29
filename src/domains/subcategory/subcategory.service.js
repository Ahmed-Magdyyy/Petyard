import { SubcategoryModel } from "./subcategory.model.js";
import { CategoryModel } from "../category/category.model.js";
import { ApiError } from "../../shared/ApiError.js";
import slugify from "slugify";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import {
  validateImageFile,
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
} from "../../shared/utils/imageUpload.js";

export async function getSubcategoriesService(query = {}, lang = "en") {
  const { category } = query;
  const normalizedLang = lang === "ar" ? "ar" : "en";

  const filter = {};
  if (category) {
    filter.category = category;
  }

  const subcategories = await SubcategoryModel.find(filter)
    .populate("category", "_id slug name_en name_ar")
    .sort({ category: 1, slug: 1 });

  return subcategories.map((s) => ({
    id: s._id,
    category: s.category?._id || s.category,
    slug: s.slug,
    name: pickLocalizedField(s, "name", normalizedLang),
    desc: pickLocalizedField(s, "desc", normalizedLang),
    image: s.image?.url || null,
  }));
}

export async function getSubcategoryByIdService(id, lang = "en") {
  const normalizedLang = lang === "ar" ? "ar" : "en";

  const subcategory = await SubcategoryModel.findById(id).populate(
    "category",
    "_id slug name_en name_ar"
  );
  if (!subcategory) {
    throw new ApiError(`No subcategory found for this id: ${id}`, 404);
  }

  return {
    id: subcategory._id,
    category: subcategory.category?._id || subcategory.category,
    slug: subcategory.slug,
    name: pickLocalizedField(subcategory, "name", normalizedLang),
    desc: pickLocalizedField(subcategory, "desc", normalizedLang),
    image: subcategory.image?.url || null,
  };
}

export async function createSubcategoryService(payload, file) {
  const { category, name_en, name_ar, desc_en, desc_ar } = payload;

  const categoryExists = await CategoryModel.exists({ _id: category });
  if (!categoryExists) {
    throw new ApiError(`No category found for this id: ${category}`, 400);
  }

  const normalizedSlug = slugify(String(name_en), {
    lower: true,
    strict: true,
    trim: true,
  });

  if (!normalizedSlug) {
    throw new ApiError("Unable to generate slug from name_en", 400);
  }

  const existing = await SubcategoryModel.findOne({ category, slug: normalizedSlug });
  if (existing) {
    throw new ApiError(
      `Subcategory with slug '${normalizedSlug}' already exists for this category`,
      409
    );
  }

  let image;
  let uploadedPublicId;

  if (file) {
    validateImageFile(file);
    image = await uploadImageToCloudinary(file, {
      folder: "petyard/subcategories",
      publicId: `subcategory_${normalizedSlug}_${Date.now()}`,
    });
    uploadedPublicId = image?.public_id;
  }

  try {
    const subcategory = await SubcategoryModel.create({
      slug: normalizedSlug,
      category,
      name_en,
      name_ar,
      desc_en,
      desc_ar,
      ...(image && { image }),
    });

    return subcategory;
  } catch (err) {
    if (uploadedPublicId) {
      await deleteImageFromCloudinary(uploadedPublicId);
    }
    throw err;
  }
}

export async function updateSubcategoryService(id, payload, file) {
  const subcategory = await SubcategoryModel.findById(id);
  if (!subcategory) {
    throw new ApiError(`No subcategory found for this id: ${id}`, 404);
  }

  const { category, name_en, name_ar, desc_en, desc_ar } = payload;

  if (category !== undefined) {
    const categoryExists = await CategoryModel.exists({ _id: category });
    if (!categoryExists) {
      throw new ApiError(`No category found for this id: ${category}`, 400);
    }
    subcategory.category = category;
  }

  if (name_en !== undefined) subcategory.name_en = name_en;
  if (name_ar !== undefined) subcategory.name_ar = name_ar;
  if (desc_en !== undefined) subcategory.desc_en = desc_en;
  if (desc_ar !== undefined) subcategory.desc_ar = desc_ar;

  let newImage;
  let oldPublicId;

  if (file) {
    validateImageFile(file);
    oldPublicId = subcategory.image?.public_id;
    newImage = await uploadImageToCloudinary(file, {
      folder: "petyard/subcategories",
      publicId: `subcategory_${subcategory.slug}_${Date.now()}`,
    });
    subcategory.image = newImage;
  }

  try {
    const updated = await subcategory.save();

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

export async function deleteSubcategoryService(id) {
  const subcategory = await SubcategoryModel.findById(id);
  if (!subcategory) {
    throw new ApiError(`No subcategory found for this id: ${id}`, 404);
  }

  if (subcategory.image?.public_id) {
    await deleteImageFromCloudinary(subcategory.image.public_id);
  }

  await SubcategoryModel.deleteOne({ _id: id });
}
