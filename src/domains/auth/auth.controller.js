// src/domains/auth/auth.controller.js
import asyncHandler from "express-async-handler";
import {
  signupService,
  resendOtpService,
  verifyPhoneService,
  loginService,
  refreshTokenService,
  logoutService,
  forgetPasswordService,
  verifyPasswordResetCodeService,
  resetPasswordService,
} from "./auth.service.js";
import { roles } from "../../shared/constants/enums.js";

// POST /auth/signup
// Body: { name, email, phone, password }
export const signup = asyncHandler(async (req, res) => {
  console.log("req.body:", req.body);
  
  const data = await signupService(req.body);
  res.status(201).json({
    message: "User created. OTP sent to phone.",
    data,
  });
});

// POST /auth/resend-otp
// Body: { phone }
export const resendOtp = asyncHandler(async (req, res) => {
  const data = await resendOtpService(req.body);
  res.status(200).json({
    message: "OTP resent to phone.",
    data,
  });
});

// POST /auth/verify-phone
// Body: { phone, otp }
export const verifyPhone = asyncHandler(async (req, res) => {
  const data = await verifyPhoneService(req.body);
  res.status(200).json({
    message: "Phone verified successfully.",
    data,
  });
});

// POST /auth/login
// Body: { email, password }
export const login = asyncHandler(async (req, res) => {
  const { user, accessToken, refreshToken, accessTokenExpires } =
    await loginService(req.body);

  // res.cookie("refreshToken", refreshToken, {
  //   httpOnly: true,
  //   secure: process.env.NODE_ENV === "production",
  //   sameSite: "Strict",
  //   maxAge: 30 * 24 * 60 * 60 * 1000,
  // });

  res.status(200).json({
    data: {
      id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      ...(user.role === roles.ADMIN || user.role === roles.SUPER_ADMIN
        ? { enabledControls: user.enabledControls }
        : {}),
    },
    accessToken,
    refreshToken,
    accessTokenExpires,
  });
});

// POST /auth/refresh-token
export const refreshToken = asyncHandler(async (req, res) => {
  // Mobile (Flutter) sends refresh token in request body
  const incoming = req.body?.refreshToken;

  const {
    accessToken,
    refreshToken: newRefreshToken,
    accessTokenExpires,
  } = await refreshTokenService({ refreshToken: incoming });

  // For future web usage (React), you may want to set the new refresh token as a cookie:
  //
  // if (newRefreshToken) {
  //   res.cookie("refreshToken", newRefreshToken, {
  //     httpOnly: true,
  //     secure: process.env.NODE_ENV === "production",
  //     sameSite: "Strict",
  //     maxAge: 30 * 24 * 60 * 60 * 1000,
  //   });
  // }

  // Current behavior: return both tokens in JSON for mobile clients.
  res.status(200).json({
    accessToken,
    refreshToken: newRefreshToken,
    accessTokenExpires,
  });
});

// POST /auth/logout
export const logout = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;

  await logoutService({ userId: req.user._id, refreshToken });

  // res.clearCookie("refreshToken", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "Strict" });

  res.status(200).json({
    status: "success",
    message: "Logged out successfully",
  });
});

// POST /auth/forget-password
export const forgetPassword = asyncHandler(async (req, res) => {
  await forgetPasswordService(req.body);

  res.status(200).json({
    status: "success",
    message: "Reset code sent to email",
  });
});

// POST /auth/verify-reset-code
export const verifyPasswordResetCode = asyncHandler(async (req, res) => {
  await verifyPasswordResetCodeService(req.body);

  res.status(200).json({
    status: "success",
    message: "Reset code verified",
  });
});

// POST /auth/reset-password
export const resetPassword = asyncHandler(async (req, res) => {
  await resetPasswordService(req.body);

  res.status(200).json({
    status: "success",
    message: "Password reset successfully, please login again",
  });
});
