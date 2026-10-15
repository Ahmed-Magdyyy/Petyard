import { ApiError } from "../../shared/utils/ApiError.js";

export const PRODUCT_MAX_IMAGES = 10;
export const PRODUCT_IMAGE_UPLOAD_LIMITS = Object.freeze({
  fileSize: 5 * 1024 * 1024, files: PRODUCT_MAX_IMAGES,
  fields: 1000, fieldSize: 16 * 1024, parts: 1000 + PRODUCT_MAX_IMAGES,
  fieldNameSize: 100, headerPairs: 100,
});

function invalid(path, message) {
  throw new ApiError(message, 400, [{ path, msg: message, code: "PRODUCT_IMAGE_INVALID" }]);
}

export function imageIndex(value, count, path = "mainImageIndex") {
  if (value === undefined || value === null) return null;
  const index = typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
    invalid(path, `Choose an integer image index between 0 and ${Math.max(count - 1, 0)} in the final gallery.`);
  }
  return index;
}

export function validateGalleryEdit(existing, files, { useImageMerge, publicIds }, mainIndex, variants) {
  const ids = new Set(existing.map((image) => image.public_id));
  publicIds.forEach((id, index) => {
    if (!ids.has(id)) invalid(`removedImagePublicIds[${index}]`, "Removal ID must belong to this product's gallery.");
  });
  const retained = useImageMerge ? existing.filter((image) => !publicIds.includes(image.public_id)) : existing;
  const count = files.length ? (useImageMerge ? retained.length : 0) + files.length : retained.length;
  if (count > PRODUCT_MAX_IMAGES) invalid("images", "The final product gallery can contain at most 10 images.");
  imageIndex(mainIndex, count);
  if (Array.isArray(variants)) variants.forEach((variant, index) => imageIndex(variant.imageIndex, count, `variants[${index}].imageIndex`));
}

export function selectMainImage(images, requestedIndex) {
  if (!images.length) {
    imageIndex(requestedIndex, 0);
    return [];
  }
  const requested = imageIndex(requestedIndex, images.length);
  const previous = images.findIndex((image) => image.isMain);
  const selected = requested ?? (previous < 0 ? 0 : previous);
  return images.map((image, index) => ({ ...image, isMain: index === selected }));
}
