import { ApiError } from "../utils/ApiError.js";

const handelJwtInvalidSignature = () =>
  new ApiError("Invalid token, Please login again", 401);

const handelJwtExpire = () =>
  new ApiError("Expired token, Please login again", 401);

const handleDuplicateFieldsDB = (err) => {
  // keyValue may be undefined in newer Mongoose / MongoDB driver versions
  if (err.keyValue && typeof err.keyValue === "object") {
    const field = Object.keys(err.keyValue)[0];
    const message = `${field} already exists. Please use another ${field}!`;
    return new ApiError(message, 400);
  }

  // Fallback: try to extract field name from the error message
  const match = err.message?.match(/index:\s+(?:\w+\.)*?(\w+)_/);
  if (match) {
    const field = match[1];
    return new ApiError(
      `${field} already exists. Please use another ${field}!`,
      400,
    );
  }

  return new ApiError(
    "Duplicate value entered. Please use a different value.",
    400,
  );
};

const handleValidationErrorDB = (err) => {
  const errors = Object.values(err.errors).map((el) => el.message);
  const message = `Invalid input data: ${errors.join(". ")}`;
  return new ApiError(message, 400);
};

const handleCastErrorDB = (err) => {
  const message = `Invalid ${err.path}: ${err.value}`;
  return new ApiError(message, 400);
};

const handleMulterError = (err) => {
  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return new ApiError(`Unexpected file field: ${err.field}`, 400);
  }

  if (err.code === "LIMIT_FILE_SIZE") {
    return new ApiError("Uploaded file is too large", 400);
  }

  return new ApiError(err.message || "Invalid file upload", 400);
};

const buildErrorResponse = (err, { includeStack = false } = {}) => {
  const body = {
    status: err.status,
    error: err.errors || [],
    message: err.message,
  };

  if (includeStack) {
    body.stack = err.stack;
  }

  return body;
};

const logOperationalError = (err, req) => {
  console.warn(
    "Operational error",
    JSON.stringify({
      statusCode: err.statusCode,
      status: err.status,
      message: err.message,
      errors: err.errors || [],
    }),
  );
};

const sendErrorForDev = (err, res) => {
  console.log(err);
  return res
    .status(err.statusCode)
    .json(buildErrorResponse(err, { includeStack: true }));
};

const sendErrorForProd = (err, req, res) => {
  if (err.isOperational) {
    logOperationalError(err, req);
    res.status(err.statusCode).json(buildErrorResponse(err));
  } else {
    console.error("Unexpected error", err);
    res.status(500).json({
      status: "error",
      error: [],
      message: "Something went very wrong!",
    });
  }
};

export const globalError = async (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || "error";

  let error = { ...err };
  error.message = err.message;
  error.name = err.name;
  error.code = err.code;
  error.keyValue = err.keyValue;

  if (error.code === 11000) error = handleDuplicateFieldsDB(error);
  if (error.name === "ValidationError") error = handleValidationErrorDB(error);
  if (error.name === "CastError") error = handleCastErrorDB(error);
  if (error.name === "MulterError") error = handleMulterError(error);
  if (error.name === "JsonWebTokenError") error = handelJwtInvalidSignature();
  if (error.name === "TokenExpiredError") error = handelJwtExpire();

  // Send response
  if (process.env.NODE_ENV === "development") {
    sendErrorForDev(error, res);
  } else {
    sendErrorForProd(error, req, res);
  }
};
