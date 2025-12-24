import { BannerModel } from "./banner.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  validateImageFile,
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
} from "../../shared/utils/imageUpload.js";

export async function getActiveBannersService() {
  const banners = await BannerModel.find({ isActive: true }).sort({
    position: 1,
    createdAt: 1,
  });

  return banners.map((b) => ({
    id: b._id,
    image: b.image && b.image.url ? b.image.url : null,
    target: b.target || null,
    position: typeof b.position === "number" ? b.position : 0,
  }));
}

export async function getAllBannersService() {
  const banners = await BannerModel.find({}).sort({ position: 1, createdAt: 1 });
  return banners;
}

export async function createBannerService(payload, file) {
  const {
    targetType,
    targetScreen,
    targetProductId,
    targetCategoryId,
    targetSubcategoryId,
    targetBrandId,
    targetUrl,
    position,
    isActive,
  } = payload;

  if (!targetType) {
    throw new ApiError("targetType is required", 400);
  }

  let image;
  let uploadedPublicId;

  if (file) {
    validateImageFile(file);
    image = await uploadImageToCloudinary(file, {
      folder: "petyard/banners",
      publicId: `banner_${Date.now()}`,
    });
    uploadedPublicId = image?.public_id;
  }

  const target = {
    type: targetType,
  };

  if (targetScreen !== undefined) target.screen = targetScreen;
  if (targetProductId !== undefined) target.productId = targetProductId;
  if (targetCategoryId !== undefined) target.categoryId = targetCategoryId;
  if (targetSubcategoryId !== undefined)
    target.subcategoryId = targetSubcategoryId;
  if (targetBrandId !== undefined) target.brandId = targetBrandId;
  if (targetUrl !== undefined) target.url = targetUrl;

  try {
    const banner = await BannerModel.create({
      target,
      ...(typeof position === "number" && { position }),
      ...(typeof isActive === "boolean" && { isActive }),
      ...(image && { image }),
    });

    return banner;
  } catch (err) {
    if (uploadedPublicId) {
      await deleteImageFromCloudinary(uploadedPublicId);
    }
    throw err;
  }
}

export async function updateBannerService(id, payload, file) {
  const banner = await BannerModel.findById(id);
  if (!banner) {
    throw new ApiError(`No banner found for this id: ${id}`, 404);
  }

  const {
    targetType,
    targetScreen,
    targetProductId,
    targetCategoryId,
    targetSubcategoryId,
    targetBrandId,
    targetUrl,
    position,
    isActive,
  } = payload;

  if (!banner.target) {
    banner.target = { type: banner.target?.type || "generic" };
  }

  if (targetType !== undefined) banner.target.type = targetType;
  if (targetScreen !== undefined) banner.target.screen = targetScreen;
  if (targetProductId !== undefined) banner.target.productId = targetProductId;
  if (targetCategoryId !== undefined) banner.target.categoryId = targetCategoryId;
  if (targetSubcategoryId !== undefined)
    banner.target.subcategoryId = targetSubcategoryId;
  if (targetBrandId !== undefined) banner.target.brandId = targetBrandId;
  if (targetUrl !== undefined) banner.target.url = targetUrl;

  if (position !== undefined) banner.position = position;
  if (isActive !== undefined) banner.isActive = isActive;

  let newImage;
  let oldPublicId;

  if (file) {
    validateImageFile(file);
    oldPublicId = banner.image?.public_id;
    newImage = await uploadImageToCloudinary(file, {
      folder: "petyard/banners",
      publicId: `banner_${banner._id}_${Date.now()}`,
    });
    banner.image = newImage;
  }

  try {
    const updated = await banner.save();

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

export async function deleteBannerService(id) {
  const banner = await BannerModel.findById(id);
  if (!banner) {
    throw new ApiError(`No banner found for this id: ${id}`, 404);
  }

  if (banner.image?.public_id) {
    await deleteImageFromCloudinary(banner.image.public_id);
  }

  await BannerModel.deleteOne({ _id: id });
}
