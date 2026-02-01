import multer from "multer";

const storage = multer.memoryStorage();

export const uploadSingleImage = (fieldName) =>
  multer({ storage }).single(fieldName);

export const uploadMultipleImages = (fieldName, maxCount = 5) =>
  multer({ storage }).array(fieldName, maxCount);
