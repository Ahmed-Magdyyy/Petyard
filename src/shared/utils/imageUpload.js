import { ApiError } from "./ApiError.js";
import cloudinary from "./cloudinary.js";

const DEFAULT_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
];

const DEFAULT_MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

export function validateImageFile(
  file,
  {
    allowedMimeTypes = DEFAULT_ALLOWED_MIME_TYPES,
    maxSizeBytes = DEFAULT_MAX_SIZE_BYTES,
  } = {}
) {
  if (!file) return;

  if (!allowedMimeTypes.includes(file.mimetype)) {
    throw new ApiError(
      `Invalid image type. Allowed types: ${allowedMimeTypes.join(", ")}`,
      400
    );
  }

  if (typeof file.size === "number" && file.size > maxSizeBytes) {
    const maxMb = (maxSizeBytes / (1024 * 1024)).toFixed(1);
    throw new ApiError(`Image is too large. Maximum size is ${maxMb} MB`, 400);
  }
}

export async function uploadImageToCloudinary(file, { folder, publicId } = {}) {
  if (!file) return null;

  const dataUri = `data:${file.mimetype};base64,${file.buffer.toString(
    "base64"
  )}`;

  try {
    const options = { folder };
    if (publicId) {
      options.public_id = publicId;
    }

    const result = await cloudinary.uploader.upload(dataUri, options);
    return {
      public_id: result.public_id,
      url: result.secure_url || result.url,
    };
  } catch (err) {
    console.log(err);
    throw new ApiError("Failed to upload image", 500);
  }
}

export async function deleteImageFromCloudinary(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch {
    // swallow cleanup errors
  }
}
