import { BannerModel } from "./banner.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";
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
} from "../../shared/utils/cache.js";
import { parseBoundedInt } from "../../shared/utils/env.js";

const BANNER_CACHE_VERSION_KEY = "banners:version";
const BANNER_CACHE_TTL_SECONDS = parseBoundedInt(
  process.env.BANNER_CACHE_TTL_SECONDS,
  5 * 60,
  5,
  60 * 60,
);

async function invalidateBannerCaches() {
  await bumpCacheVersion(BANNER_CACHE_VERSION_KEY);
}

export async function getActiveBannersService() {
  const version = await getCacheVersion(BANNER_CACHE_VERSION_KEY);

  return getOrSetCache(
    `banners:active:v1:${version}`,
    BANNER_CACHE_TTL_SECONDS,
    async () => {
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
    },
  );
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
    isActive,
  } = payload;

  // Auto-calculate position: next after the current max
  const lastBanner = await BannerModel.findOne({}).sort({ position: -1 }).lean();
  const nextPosition = lastBanner?.position != null ? lastBanner.position + 1 : 0;


  let image;
  let uploadedImage;

  if (file) {
    validateImageFile(file);
    image = await uploadImage(file, {
      folder: "petyard/banners",
      publicId: `banner_${Date.now()}`,
      visibility: IMAGE_VISIBILITY.PUBLIC,
      profile: IMAGE_UPLOAD_PROFILES.STANDARD,
    });
    uploadedImage = image;
  }

  const target = {};
  if (targetType !== undefined) target.type = targetType;
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
      position: nextPosition,
      ...(typeof isActive === "boolean" && { isActive }),
      ...(image && { image }),
    });

    await invalidateBannerCaches();

    return banner;
  } catch (err) {
    if (uploadedImage) {
      await deleteImage(uploadedImage);
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
    isActive,
  } = payload;

  const hasTargetUpdates =
    targetType !== undefined ||
    targetScreen !== undefined ||
    targetProductId !== undefined ||
    targetCategoryId !== undefined ||
    targetSubcategoryId !== undefined ||
    targetBrandId !== undefined ||
    targetUrl !== undefined;

  if (hasTargetUpdates && !banner.target) {
    banner.target = {};
  }

  if (targetType !== undefined) banner.target.type = targetType;
  if (targetScreen !== undefined) banner.target.screen = targetScreen;
  if (targetProductId !== undefined) banner.target.productId = targetProductId;
  if (targetCategoryId !== undefined) banner.target.categoryId = targetCategoryId;
  if (targetSubcategoryId !== undefined)
    banner.target.subcategoryId = targetSubcategoryId;
  if (targetBrandId !== undefined) banner.target.brandId = targetBrandId;
  if (targetUrl !== undefined) banner.target.url = targetUrl;

  if (isActive !== undefined) banner.isActive = isActive;

  let newImage;
  let oldImage;

  if (file) {
    validateImageFile(file);
    oldImage = banner.image
      ? { public_id: banner.image.public_id, url: banner.image.url }
      : null;
    newImage = await uploadImage(file, {
      folder: "petyard/banners",
      publicId: `banner_${banner._id}_${Date.now()}`,
      visibility: IMAGE_VISIBILITY.PUBLIC,
      profile: IMAGE_UPLOAD_PROFILES.STANDARD,
    });
    banner.image = newImage;
  }

  try {
    const updated = await banner.save();

    if (oldImage) {
      await deleteImage(oldImage);
    }

    await invalidateBannerCaches();

    return updated;
  } catch (err) {
    if (newImage) {
      await deleteImage(newImage);
    }
    throw err;
  }
}

export async function deleteBannerService(id) {
  const banner = await BannerModel.findById(id);
  if (!banner) {
    throw new ApiError(`No banner found for this id: ${id}`, 404);
  }

  if (banner.image?.url) {
    await deleteImage(banner.image);
  }

  await BannerModel.deleteOne({ _id: id });
  await invalidateBannerCaches();
}

export async function reorderBannersService(banners) {
  if (!banners || !banners.length) {
    throw new ApiError("banners array is required", 400);
  }

  const bulkOps = banners.map(({ id, position }) => ({
    updateOne: {
      filter: { _id: id },
      update: { $set: { position } },
    },
  }));

  const result = await BannerModel.bulkWrite(bulkOps);

  if (result.matchedCount !== banners.length) {
    throw new ApiError(
      `Some banner IDs were not found. Expected ${banners.length}, matched ${result.matchedCount}`,
      400
    );
  }

  await invalidateBannerCaches();

  return { updated: result.modifiedCount };
}
