import { BrandModel } from "./brand.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import slugify from "slugify";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import { enabledControls, roles } from "../../shared/constants/enums.js";
import {
  validateImageFile,
  uploadImage,
  deleteImage,
  IMAGE_UPLOAD_PROFILES,
  IMAGE_VISIBILITY,
} from "../../shared/utils/imageUpload.js";
import { buildFlexibleSearchPattern } from "../../shared/utils/escapeRegex.js";

export async function getBrandsService(query = {}, lang = "en", user = null) {
  const { q } = query;
  const normalizedLang = lang === "ar" ? "ar" : "en";
  const includeAllLanguages =
    user &&
    (user.role === roles.SUPER_ADMIN ||
      (user.role === roles.ADMIN &&
        user.enabledControls?.includes(enabledControls.BRANDS)));

  const filter = {};
  if (typeof q === "string" && q.trim()) {
    const regex = {
      $regex: buildFlexibleSearchPattern(q.trim()),
      $options: "i",
    };
    filter.$or = [{ name_en: regex }, { name_ar: regex }];
  }

  const brands = await BrandModel.find(filter).sort({ slug: 1 });

  return brands.map((b) => ({
    id: b._id,
    slug: b.slug,
    updatedAt: b.updatedAt,
    ...(includeAllLanguages
      ? {
          name: pickLocalizedField(b, "name", normalizedLang),
          name_en: b.name_en,
          name_ar: b.name_ar,
          desc: pickLocalizedField(b, "desc", normalizedLang),
          desc_en: b.desc_en,
          desc_ar: b.desc_ar,
        }
      : {
          name: pickLocalizedField(b, "name", normalizedLang),
          desc: pickLocalizedField(b, "desc", normalizedLang),
        }),
    bgColor: b.bgColor || null,
    image: b.image?.url || null,
  }));
}

export async function getBrandByIdService(id, lang = "en", user = null) {
  const normalizedLang = lang === "ar" ? "ar" : "en";
  const includeAllLanguages =
    user &&
    (user.role === roles.SUPER_ADMIN ||
      (user.role === roles.ADMIN &&
        user.enabledControls?.includes(enabledControls.BRANDS)));

  const brand = await BrandModel.findById(id);
  if (!brand) {
    throw new ApiError(`No brand found for this id: ${id}`, 404);
  }

  return {
    id: brand._id,
    slug: brand.slug,
    updatedAt: brand.updatedAt,
    ...(includeAllLanguages
      ? {
          name: pickLocalizedField(brand, "name", normalizedLang),
          name_en: brand.name_en,
          name_ar: brand.name_ar,
          desc: pickLocalizedField(brand, "desc", normalizedLang),
          desc_en: brand.desc_en,
          desc_ar: brand.desc_ar,
        }
      : {
          name: pickLocalizedField(brand, "name", normalizedLang),
          desc: pickLocalizedField(brand, "desc", normalizedLang),
        }),
    bgColor: brand.bgColor || null,
    image: brand.image?.url || null,
  };
}

export async function createBrandService(payload, file) {
  const { name_en, name_ar, desc_en, desc_ar, bgColor } = payload;

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
  let uploadedImage;

  if (file) {
    validateImageFile(file);
    image = await uploadImage(file, {
      folder: "petyard/brands",
      publicId: `brand_${normalizedSlug}_${Date.now()}`,
      visibility: IMAGE_VISIBILITY.PUBLIC,
      profile: IMAGE_UPLOAD_PROFILES.STANDARD,
    });
    uploadedImage = image;
  }

  try {
    const brand = await BrandModel.create({
      slug: normalizedSlug,
      name_en,
      name_ar,
      desc_en,
      desc_ar,
      bgColor,
      ...(image && { image }),
    });

    return brand;
  } catch (err) {
    if (uploadedImage) {
      await deleteImage(uploadedImage);
    }
    throw err;
  }
}

export async function updateBrandService(id, payload, file) {
  const brand = await BrandModel.findById(id);
  if (!brand) {
    throw new ApiError(`No brand found for this id: ${id}`, 404);
  }

  const { name_en, name_ar, desc_en, desc_ar, bgColor } = payload;

  if (name_en !== undefined) brand.name_en = name_en;
  if (name_ar !== undefined) brand.name_ar = name_ar;
  if (desc_en !== undefined) brand.desc_en = desc_en;
  if (desc_ar !== undefined) brand.desc_ar = desc_ar;
  if (bgColor !== undefined) brand.bgColor = bgColor;

  let newImage;
  let oldImage;

  if (file) {
    validateImageFile(file);
    oldImage = brand.image
      ? { public_id: brand.image.public_id, url: brand.image.url }
      : null;
    newImage = await uploadImage(file, {
      folder: "petyard/brands",
      publicId: `brand_${brand.slug}_${Date.now()}`,
      visibility: IMAGE_VISIBILITY.PUBLIC,
      profile: IMAGE_UPLOAD_PROFILES.STANDARD,
    });
    brand.image = newImage;
  }

  try {
    const updated = await brand.save();

    if (oldImage) {
      await deleteImage(oldImage);
    }

    return updated;
  } catch (err) {
    if (newImage) {
      await deleteImage(newImage);
    }
    throw err;
  }
}

export async function deleteBrandService(id) {
  const brand = await BrandModel.findById(id);
  if (!brand) {
    throw new ApiError(`No brand found for this id: ${id}`, 404);
  }

  if (brand.image?.url) {
    await deleteImage(brand.image);
  }

  await BrandModel.deleteOne({ _id: id });
}
