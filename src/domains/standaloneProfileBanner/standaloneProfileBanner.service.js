import { StandaloneProfileBannerModel } from "./standaloneProfileBanner.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  validateImageFile,
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
} from "../../shared/utils/imageUpload.js";
import {
  bumpCacheVersion,
  getCacheVersion,
  getOrSetCache,
} from "../../shared/utils/cache.js";
import { parseBoundedInt } from "../../shared/utils/env.js";

const STANDALONE_PROFILE_BANNER_CACHE_VERSION_KEY =
  "standalone-profile-banner:version";
const STANDALONE_PROFILE_BANNER_CACHE_TTL_SECONDS = parseBoundedInt(
  process.env.STANDALONE_PROFILE_BANNER_CACHE_TTL_SECONDS,
  5 * 60,
  5,
  60 * 60,
);

async function invalidateStandaloneProfileBannerCache() {
  await bumpCacheVersion(STANDALONE_PROFILE_BANNER_CACHE_VERSION_KEY);
}

export async function getStandaloneProfileBannerService() {
  const version = await getCacheVersion(STANDALONE_PROFILE_BANNER_CACHE_VERSION_KEY);
  return getOrSetCache(
    `standalone-profile-banner:v1:${version}`,
    STANDALONE_PROFILE_BANNER_CACHE_TTL_SECONDS,
    () => StandaloneProfileBannerModel.findOne(),
  );
}

export async function createStandaloneProfileBannerService(file) {
  if (!file) {
    throw new ApiError("Image file is required", 400);
  }

  const existingBanner = await StandaloneProfileBannerModel.findOne();
  if (existingBanner) {
    throw new ApiError(
      "Standalone banner already exists. Use the update route instead.",
      400,
    );
  }

  validateImageFile(file);

  const newImage = await uploadImageToCloudinary(file, {
    folder: "petyard/standalone-profile-banners",
    publicId: `standalone_profile_banner_${Date.now()}`,
  });

  try {
    const banner = await StandaloneProfileBannerModel.create({
      image: newImage,
    });
    await invalidateStandaloneProfileBannerCache();
    return banner;
  } catch (err) {
    if (newImage?.public_id) {
      await deleteImageFromCloudinary(newImage.public_id);
    }
    throw err;
  }
}

export async function updateStandaloneProfileBannerService(file) {
  if (!file) {
    throw new ApiError("Image file is required", 400);
  }

  validateImageFile(file);

  let banner = await StandaloneProfileBannerModel.findOne();
  if (!banner) {
    throw new ApiError(
      "No standalone banner found. Please create one first.",
      404,
    );
  }

  const newImage = await uploadImageToCloudinary(file, {
    folder: "petyard/standalone-profile-banners",
    publicId: `standalone_profile_banner_${Date.now()}`,
  });

  try {
    const oldPublicId = banner.image?.public_id;
    banner.image = newImage;
    await banner.save();

    if (oldPublicId) {
      await deleteImageFromCloudinary(oldPublicId);
    }

    await invalidateStandaloneProfileBannerCache();

    return banner;
  } catch (err) {
    if (newImage?.public_id) {
      await deleteImageFromCloudinary(newImage.public_id);
    }
    throw err;
  }
}
