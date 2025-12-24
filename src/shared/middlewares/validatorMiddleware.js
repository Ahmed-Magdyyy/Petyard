import { validationResult } from "express-validator";
import { ApiError } from "../utils/ApiError.js";

export const validatorMiddleware = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const formatted = errors.array().map((e) => ({
      field: e.param,
      message: e.msg,
    }));

    return next(new ApiError("Validation error", 400, formatted));
  }

  next();
};