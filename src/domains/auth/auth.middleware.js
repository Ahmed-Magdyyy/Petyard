import asyncHandler from "express-async-handler";
import jwt from "jsonwebtoken";
import { ApiError } from "../../shared/utils/ApiError.js";
import { UserModel } from "../user/user.model.js";
import { authProviderEnum, roles, accountStatus } from "../../shared/constants/enums.js";

export const protect = asyncHandler(async (req, res, next) => {
  let accessToken;

  if (req.headers.authorization?.startsWith("Bearer")) {
    accessToken = req.headers.authorization.split(" ")[1];
  }

  if (!accessToken) {
    throw new ApiError("Please login first", 401);
  }

  let decoded;
  try {
    decoded = jwt.verify(accessToken, process.env.JWT_ACCESS_SECRET);
  } catch {
    throw new ApiError("Invalid or expired token, please login again", 401);
  }

  const currentUser = await UserModel.findById(decoded.userId);

  if (!currentUser) {
    throw new ApiError("User no longer exists", 401);
  }

  if (currentUser.deletedAt) {
    throw new ApiError("User no longer exists", 401);
  }

  if (currentUser.account_status === accountStatus.PANNED) {
    throw new ApiError("Your account have been panned. please contact support", 403)
  }

  if (
    currentUser.passwordChangedAT &&
    currentUser.passwordChangedAT.getTime() > decoded.iat * 1000
  ) {
    throw new ApiError(
      "Password was changed recently, please login again",
      401
    );
  }

  if (!currentUser.active) {
    throw new ApiError("Account is not active. Contact customer support", 401);
  }

  req.user = currentUser;
  next();
});

export const optionalProtect = asyncHandler(async (req, res, next) => {
  let accessToken;

  if (req.headers.authorization?.startsWith("Bearer")) {
    accessToken = req.headers.authorization.split(" ")[1];
  }

  if (!accessToken) {
    return next();
  }

  let decoded;
  try {
    decoded = jwt.verify(accessToken, process.env.JWT_ACCESS_SECRET);
  } catch {
    throw new ApiError("Invalid or expired token, please login again", 401);
  }

  const currentUser = await UserModel.findById(decoded.userId);

  if (!currentUser) {
    throw new ApiError("User no longer exists", 401);
  }

  if (currentUser.deletedAt) {
    throw new ApiError("User no longer exists", 401);
  }

  if (
    currentUser.passwordChangedAT &&
    currentUser.passwordChangedAT.getTime() > decoded.iat * 1000
  ) {
    throw new ApiError("Password was changed recently, please login again", 401);
  }

  if (!currentUser.active) {
    throw new ApiError("Account is not active. Contact customer support", 401);
  }

  req.user = currentUser;
  return next();
});

export const allowedTo = (...allowedRoles) =>
  asyncHandler(async (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      throw new ApiError("You are not allowed to access this route", 403);
    }
    next();
  });

export const enabledControls = (...scope) =>
  asyncHandler(async (req, res, next) => {
    if (req.user.role === roles.ADMIN) {
      const normalizedScope = scope.flat();
      const hasControl = normalizedScope.every((s) =>
        req.user.enabledControls?.includes(s)
      );
      if (!hasControl) {
        throw new ApiError(
          "You don't have the permission to access this. Contact support to enable it.",
          403
        );
      }
    }
    next();
  });

export const onlySocialProfileCompletionPhone = asyncHandler(
  async (req, res, next) => {
    if (!req.user) {
      throw new ApiError("Please login first", 401);
    }

    if (req.user.signupProvider === authProviderEnum.SYSTEM) {
      throw new ApiError(
        "Only users who signed up via Google/Apple allowed for this route",
        403
      );
    }

    if (req.user.phone) {
      throw new ApiError("Phone is already set.", 403);
    }

    next();
  }
);

export const requireSystemPhoneVerifiedForSensitiveActions = asyncHandler(
  async (req, res, next) => {
    if (!req.user) {
      throw new ApiError("Please login first", 401);
    }

    if (!req.user.phone) {
      throw new ApiError("Please add your phone first", 403);
    }

    if (!req.user.phoneVerified) {
      throw new ApiError("Please verify your phone first", 403);
    }

    next();
  }
);
