import crypto from "crypto";
import sharp from "sharp";
import cloudinary from "./cloudinary.js";
import { ApiError } from "./ApiError.js";
import {
  MEDIA_STORAGE_PROVIDERS,
  getMediaConfiguration,
} from "./mediaConfig.js";
import {
  buildBunnyCdnUrl,
  deleteBunnyObject,
  getBunnyObjectKeyFromUrl,
  uploadBunnyObject,
} from "./bunnyStorage.js";

export const IMAGE_UPLOAD_PROFILES = Object.freeze({
  STANDARD: "standard",
  TILE: "tile",
  PROOF: "proof",
});

export const IMAGE_VISIBILITY = Object.freeze({
  PUBLIC: "public",
  PRIVATE: "private",
});

const DEFAULT_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
];
const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024;
const CLOUDINARY_IMAGE_HOST = "res.cloudinary.com";

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

function validateFolder(folder, visibility) {
  const allowedRoot =
    visibility === IMAGE_VISIBILITY.PRIVATE
      ? "instapay_screenshots"
      : "petyard";

  if (
    typeof folder !== "string" ||
    !folder ||
    /\\/.test(folder) ||
    folder.includes("://") ||
    (folder !== allowedRoot && !folder.startsWith(`${allowedRoot}/`))
  ) {
    throw new ApiError("Invalid media folder", 400);
  }

  const segments = folder.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[\0-\x1f?#]/.test(segment),
    )
  ) {
    throw new ApiError("Invalid media folder", 400);
  }
}

async function processImage(file, profile) {
  if (file.mimetype === "image/svg+xml") {
    return {
      buffer: file.buffer,
      contentType: file.mimetype,
      extension: "svg",
    };
  }
  if (file.mimetype === "image/gif") {
    return {
      buffer: file.buffer,
      contentType: file.mimetype,
      extension: "gif",
    };
  }

  const resizeOptions =
    profile === IMAGE_UPLOAD_PROFILES.TILE
      ? {
          width: 480,
          fit: "inside",
          withoutEnlargement: true,
        }
      : {
          width: 1920,
          height: 1080,
          fit: "inside",
          withoutEnlargement: true,
        };

  const buffer = await sharp(file.buffer)
    .resize(resizeOptions)
    .webp({ quality: 80 })
    .toBuffer();

  return {
    buffer,
    contentType: "image/webp",
    extension: "webp",
  };
}

async function uploadToCloudinary(
  file,
  { folder, publicId, cloudinaryClient },
) {
  const { buffer } = await processImage(
    file,
    IMAGE_UPLOAD_PROFILES.STANDARD,
  );

  try {
    const uploadOptions = { folder, resource_type: "image" };
    if (publicId) {
      uploadOptions.public_id = publicId;
    }

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinaryClient.uploader.upload_stream(
        uploadOptions,
        (error, response) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(response);
        },
      );
      stream.end(buffer);
    });

    return {
      public_id: result.public_id,
      url: result.secure_url || result.url,
    };
  } catch {
    throw new ApiError("Failed to upload image", 500);
  }
}

export async function uploadImage(
  file,
  {
    folder,
    publicId,
    visibility = IMAGE_VISIBILITY.PUBLIC,
    profile = IMAGE_UPLOAD_PROFILES.STANDARD,
    configuration,
    cloudinaryClient = cloudinary,
    bunnyUpload = uploadBunnyObject,
    uuid = crypto.randomUUID,
  } = {},
) {
  if (!file) return null;

  validateImageFile(file);
  if (!Object.values(IMAGE_VISIBILITY).includes(visibility)) {
    throw new ApiError("Invalid image visibility", 400);
  }
  if (!Object.values(IMAGE_UPLOAD_PROFILES).includes(profile)) {
    throw new ApiError("Invalid image upload profile", 400);
  }
  validateFolder(folder, visibility);

  const config = configuration || getMediaConfiguration();
  const provider =
    visibility === IMAGE_VISIBILITY.PRIVATE
      ? config.privateProvider
      : config.publicProvider;

  if (provider === MEDIA_STORAGE_PROVIDERS.CLOUDINARY) {
    return uploadToCloudinary(file, {
      folder,
      publicId,
      cloudinaryClient,
    });
  }

  const bunny =
    visibility === IMAGE_VISIBILITY.PRIVATE ? config.private : config.public;
  if (!bunny) {
    throw new ApiError("Bunny media configuration is required", 500);
  }

  const logicalPublicId = publicId
    ? `${folder}/${publicId}`
    : `${folder}/${uuid()}`;
  const processed = await processImage(file, profile);
  const objectKey = `${logicalPublicId}.${processed.extension}`;

  await bunnyUpload({
    ...bunny,
    objectKey,
    buffer: processed.buffer,
    contentType: processed.contentType,
    timeoutMs: config.storageTimeoutMs,
  });

  return {
    public_id: logicalPublicId,
    url: buildBunnyCdnUrl({
      cdnBaseUrl: bunny.cdnBaseUrl,
      objectKey,
    }),
  };
}

function getCloudinaryDescriptor(imageDescriptor) {
  if (
    typeof imageDescriptor?.url !== "string" ||
    typeof imageDescriptor?.public_id !== "string" ||
    !imageDescriptor.public_id
  ) {
    return null;
  }

  try {
    const parsed = new URL(imageDescriptor.url);
    if (
      parsed.protocol === "https:" &&
      parsed.hostname === CLOUDINARY_IMAGE_HOST &&
      parsed.pathname.includes("/image/upload/")
    ) {
      return imageDescriptor;
    }
  } catch {
    return null;
  }

  return null;
}

export async function deleteImage(
  imageDescriptor,
  {
    configuration,
    cloudinaryClient = cloudinary,
    bunnyDelete = deleteBunnyObject,
    logger = console,
  } = {},
) {
  if (
    !imageDescriptor ||
    typeof imageDescriptor !== "object" ||
    typeof imageDescriptor.url !== "string"
  ) {
    return;
  }

  try {
    const config = configuration || getMediaConfiguration();
    const candidates = [
      { bunny: config.public, allowedRoot: "petyard" },
      {
        bunny: config.private,
        allowedRoot: "instapay_screenshots",
      },
    ];

    for (const { bunny, allowedRoot } of candidates) {
      if (!bunny) continue;

      const objectKey = getBunnyObjectKeyFromUrl({
        url: imageDescriptor.url,
        cdnBaseUrl: bunny.cdnBaseUrl,
        allowedRoot,
      });
      if (!objectKey) continue;

      await bunnyDelete({
        ...bunny,
        objectKey,
        timeoutMs: config.storageTimeoutMs,
      });
      return;
    }

    const cloudinaryDescriptor = getCloudinaryDescriptor(imageDescriptor);
    if (cloudinaryDescriptor) {
      await cloudinaryClient.uploader.destroy(
        cloudinaryDescriptor.public_id,
      );
    }
  } catch {
    logger.warn("[Media] provider cleanup failed");
  }
}
