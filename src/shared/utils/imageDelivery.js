import { parseBoolean } from "./env.js";

const CATEGORY_TILE_TRANSFORMATION = "c_limit,w_480,q_auto:good,f_webp";

export const IMAGE_DELIVERY_PRESETS = Object.freeze({
  CATEGORY_TILE: "category-tile",
  SUBCATEGORY_TILE: "subcategory-tile",
});

const presetTransformations = Object.freeze({
  [IMAGE_DELIVERY_PRESETS.CATEGORY_TILE]: CATEGORY_TILE_TRANSFORMATION,
  [IMAGE_DELIVERY_PRESETS.SUBCATEGORY_TILE]: CATEGORY_TILE_TRANSFORMATION,
});

const optimizationEnabled = parseBoolean(
  process.env.CLOUDINARY_DELIVERY_OPTIMIZATION_ENABLED,
  false,
);
const configuredCloudName =
  typeof process.env.CLOUDINARY_CLOUD_NAME === "string"
    ? process.env.CLOUDINARY_CLOUD_NAME.trim()
    : "";

export const IMAGE_DELIVERY_CACHE_NAMESPACE = optimizationEnabled
  ? "cloudinary-w480-webp-qauto-good-v1"
  : "original-v1";

export function getImageDeliveryUrl(url, preset, options = {}) {
  const { enabled = optimizationEnabled, cloudName = configuredCloudName } = options;
  if (enabled !== true) return url;
  if (typeof url !== "string" || !url) return url;
  if (typeof cloudName !== "string" || !cloudName.trim()) return url;
  const transformation = presetTransformations[preset];
  if (!transformation) return url;
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { return url; }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") return url;
  if (parsedUrl.hostname !== "res.cloudinary.com") return url;
  const segments = parsedUrl.pathname.split("/");
  if (segments[0] !== "" || segments[1] !== cloudName.trim() || segments[2] !== "image" || segments[3] !== "upload") return url;
  const versionIndex = segments.findIndex((segment, index) => index > 3 && /^v\d+$/.test(segment));
  if (versionIndex === -1) return url;
  if (segments.slice(4, versionIndex).some((segment) => segment)) return url;
  parsedUrl.pathname = [...segments.slice(0, 4), transformation, ...segments.slice(versionIndex)].join("/");
  return parsedUrl.toString();
}

export function getImageObjectWithDeliveryUrl(image, preset, options = {}) {
  if (image == null || typeof image.url !== "string" || !image.url) return image;
  const deliveryUrl = getImageDeliveryUrl(image.url, preset, options);
  if (deliveryUrl === image.url) return image;
  const serializedImage = typeof image.toObject === "function" ? image.toObject() : { ...image };
  return { ...serializedImage, url: deliveryUrl };
}