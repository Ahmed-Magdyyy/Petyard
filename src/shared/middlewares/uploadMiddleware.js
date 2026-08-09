import multer from "multer";

const storage = multer.memoryStorage();

export const uploadSingleImage = (fieldName) =>
  multer({ storage }).single(fieldName);

export const uploadMultipleImages = (fieldName, maxCount = 10) =>
  multer({ storage }).array(fieldName, maxCount);

export const uploadImageFields = (fields, maxFiles = 10) =>
  multer({ storage, limits: { files: maxFiles } }).fields(fields);
