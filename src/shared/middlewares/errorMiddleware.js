import { ApiError } from "../ApiError.js";
// const { deleteImageCloud } = require("../utils/Cloudinary/cloud");

const handelJwtInvalidSignature = () =>
  new ApiError("Invalid token, Please login again", 401);

const handelJwtExpire = () =>
  new ApiError("Expired token, Please login again", 401);

const handleDuplicateFieldsDB = (err) => {
  const field = Object.keys(err.keyValue)[0];
  const message = `${field} already exists. Please use another ${field}!`;
  return new ApiError(message, 400);
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

const sendErrorForDev = (err, res) => {
  console.log(err);
  return res.status(err.statusCode).json({
    status: err.status,
    error: err.errors || [],
    message: err.message,
    stack: err.stack,
  });
};

const sendErrorForProd = (err, res) => {
  if (err.isOperational) {
    res.status(err.statusCode).json({
      status: err.status,
      message: err.message,
      errors: err.errors || [],
    });
  } else {
    console.error("ERROR 💥", err);
    res.status(500).json({
      status: "error",
      message: "Something went very wrong!",
    });
  }
};

export const globalError = async (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || "error";
  console.log("error", err);

  let error = { ...err };
  error.message = err.message;

  if (error.code === 11000) error = handleDuplicateFieldsDB(error);
  if (error.name === "ValidationError") error = handleValidationErrorDB(error);
  if (error.name === "CastError") error = handleCastErrorDB(error);
  if (error.name === "JsonWebTokenError") error = handelJwtInvalidSignature();
  if (error.name === "TokenExpiredError") error = handelJwtExpire();

  // Send response
  if (process.env.NODE_ENV === "development") {
    sendErrorForDev(error, res);
  } else {
    sendErrorForProd(error, res);
  }
};
