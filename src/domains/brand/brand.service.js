import { BrandModel } from "./brand.model.js";
import { ApiError } from "../../shared/ApiError.js";
import slugify from "slugify";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import {
  validateImageFile,
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
} from "../../shared/utils/imageUpload.js";

export async function getBrandsService(lang = "en") {
  const normalizedLang = lang === "ar" ? "ar" : "en";

  const brands = await BrandModel.find({}).sort({ slug: 1 });

  return brands.map((b) => ({
    id: b._id,
    slug: b.slug,
    name: pickLocalizedField(b, "name", normalizedLang),
    desc: pickLocalizedField(b, "desc", normalizedLang),
    image: b.image?.url || null,
  }));
}

export async function getBrandByIdService(id, lang = "en") {
  const normalizedLang = lang === "ar" ? "ar" : "en";

  const brand = await BrandModel.findById(id);
  if (!brand) {
    throw new ApiError(`No brand found for this id: ${id}`, 404);
  }

  return {
    id: brand._id,
    slug: brand.slug,
    name: pickLocalizedField(brand, "name", normalizedLang),
    desc: pickLocalizedField(brand, "desc", normalizedLang),
    image: brand.image?.url || null,
  };
}

export async function createBrandService(payload, file) {
  const { name_en, name_ar, desc_en, desc_ar } = payload;

  const normalizedSlug = slugify(String(name_en), {
    lower: true,
    strict: true,
    trim: true,
  });

  if (!normalizedSlug) {
    throw new ApiError("Unable to generate slug from name_en", 400);
  }

  const existing = await BrandModel.findOne({ slug: normalizedSlug });
  if (existing) {
    throw new ApiError(`Brand with slug '${normalizedSlug}' already exists`, 409);
  }

  let image;
  let uploadedPublicId;

  if (file) {
    validateImageFile(file);
    image = await uploadImageToCloudinary(file, {
      folder: "petyard/brands",
      publicId: `brand_${normalizedSlug}_${Date.now()}`,
    });
    uploadedPublicId = image?.public_id;
  }

  try {
    const brand = await BrandModel.create({
      slug: normalizedSlug,
      name_en,
      name_ar,
      desc_en,
      desc_ar,
      ...(image && { image }),
    });

    return brand;
  } catch (err) {
    if (uploadedPublicId) {
      await deleteImageFromCloudinary(uploadedPublicId);
    }
    throw err;
  }
}

export async function updateBrandService(id, payload, file) {
  const brand = await BrandModel.findById(id);
  if (!brand) {
    throw new ApiError(`No brand found for this id: ${id}`, 404);
  }

  const { name_en, name_ar, desc_en, desc_ar } = payload;

  if (name_en !== undefined) brand.name_en = name_en;
  if (name_ar !== undefined) brand.name_ar = name_ar;
  if (desc_en !== undefined) brand.desc_en = desc_en;
  if (desc_ar !== undefined) brand.desc_ar = desc_ar;

  let newImage;
  let oldPublicId;

  if (file) {
    validateImageFile(file);
    oldPublicId = brand.image?.public_id;
    newImage = await uploadImageToCloudinary(file, {
      folder: "petyard/brands",
      publicId: `brand_${brand.slug}_${Date.now()}`,
    });
    brand.image = newImage;
  }

  try {
    const updated = await brand.save();

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

export async function deleteBrandService(id) {
  const brand = await BrandModel.findById(id);
  if (!brand) {
    throw new ApiError(`No brand found for this id: ${id}`, 404);
  }

  if (brand.image?.public_id) {
    await deleteImageFromCloudinary(brand.image.public_id);
  }

  await BrandModel.deleteOne({ _id: id });
}
