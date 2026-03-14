import { ApiError } from "./ApiError.js";
import cloudinary from "./cloudinary.js";
import sharp from "sharp";

const DEFAULT_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
];

const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB (raw input limit)

const SHARP_OPTIONS = {
  maxWidth: 1920,
  maxHeight: 1080,
  quality: 80,
  format: "webp",
};

export function validateImageFile(
  file,
  {
    allowedMimeTypes = DEFAULT_ALLOWED_MIME_TYPES,
    maxSizeBytes = DEFAULT_MAX_SIZE_BYTES,
  } = {},
) {
  if (!file) return;

  if (!allowedMimeTypes.includes(file.mimetype)) {
    throw new ApiError(
      `Invalid image type. Allowed types: ${allowedMimeTypes.join(", ")}`,
      400,
    );
  }

  if (typeof file.size === "number" && file.size > maxSizeBytes) {
    const maxMb = (maxSizeBytes / (1024 * 1024)).toFixed(1);
    throw new ApiError(`Image is too large. Maximum size is ${maxMb} MB`, 400);
  }
}

/**
 * Process image with sharp: resize + convert to webp for smaller file size.
 * SVGs and GIFs are skipped (sharp doesn't handle them well).
 */
async function processImage(file) {
  const skipTypes = ["image/svg+xml", "image/gif"];
  if (skipTypes.includes(file.mimetype)) {
    return { buffer: file.buffer, mimetype: file.mimetype };
  }

  const processed = await sharp(file.buffer)
    .resize(SHARP_OPTIONS.maxWidth, SHARP_OPTIONS.maxHeight, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: SHARP_OPTIONS.quality })
    .toBuffer();

  return { buffer: processed, mimetype: "image/webp" };
}

export async function uploadImageToCloudinary(file, { folder, publicId } = {}) {
  if (!file) return null;

  // Process image with sharp before uploading
  const { buffer, mimetype } = await processImage(file);
  const dataUri = `data:${mimetype};base64,${buffer.toString("base64")}`;

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
