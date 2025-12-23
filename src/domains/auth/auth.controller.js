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
  sendGuestOtpService,
  verifyGuestOtpService,
  oauthGoogleLoginService,
  oauthAppleLoginService,
  oauthSendOtpService,
  oauthVerifyPhoneService,
  oauthLinkGoogleService,
  oauthLinkAppleService,
  oauthUnlinkProviderService,
  oauthSetPasswordService,
} from "./auth.service.js";
import { roles, authProviderEnum } from "../../shared/constants/enums.js";

function buildAuthUserResponse(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    ...(user.role === roles.ADMIN || user.role === roles.SUPER_ADMIN
      ? { enabledControls: user.enabledControls }
      : {}),
  };
}

// POST /auth/signup
// Body: { name, email, phone, password }
export const signup = asyncHandler(async (req, res) => {
  
  const data = await signupService(req.body);
  res.status(201).json({
    message: "User created. OTP sent to phone.",
    data,
  });
});

// POST /auth/guest/send-otp
// Body: { phone }
export const sendGuestOtp = asyncHandler(async (req, res) => {
  const data = await sendGuestOtpService(req.body);

  res.status(200).json({
    message: "OTP sent to phone.",
    data,
  });
});

// POST /auth/guest/verify-otp
// Body: { phone, otp }
export const verifyGuestOtp = asyncHandler(async (req, res) => {
  const data = await verifyGuestOtpService(req.body);

  res.status(200).json({
    message: "OTP verified successfully.",
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
  const incoming = req.body?.refreshToken;

  const {
    accessToken,
    refreshToken: newRefreshToken,
    accessTokenExpires,
  } = await refreshTokenService({ refreshToken: incoming });

  // For future web usage
  //
  // if (newRefreshToken) {
  //   res.cookie("refreshToken", newRefreshToken, {
  //     httpOnly: true,
  //     secure: process.env.NODE_ENV === "production",
  //     sameSite: "Strict",
  //     maxAge: 30 * 24 * 60 * 60 * 1000,
  //   });
  // }

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
 const {resetCode}= await forgetPasswordService(req.body);

  res.status(200).json({
    status: "success",
    message: "Reset code sent to email",
    resetCode
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

// POST /auth/oauth/google
// Body: { idToken }
export const oauthGoogleLogin = asyncHandler(async (req, res) => {
  const { user, accessToken, refreshToken, accessTokenExpires } =
    await oauthGoogleLoginService(req.body);

  res.status(200).json({
    data: buildAuthUserResponse(user),
    accessToken,
    refreshToken,
    accessTokenExpires,
  });
});

// POST /auth/oauth/apple
// Body: { identityToken, nonce?, name? }
export const oauthAppleLogin = asyncHandler(async (req, res) => {
  const { user, accessToken, refreshToken, accessTokenExpires } =
    await oauthAppleLoginService(req.body);

  res.status(200).json({
    data: buildAuthUserResponse(user),
    accessToken,
    refreshToken,
    accessTokenExpires,
  });
});

// POST /auth/phone/send-otp
// Body: { phone }
export const oauthSendOtp = asyncHandler(async (req, res) => {
  const data = await oauthSendOtpService({ userId: req.user._id, ...req.body });
  res.status(200).json({
    message: "OTP sent to phone.",
    data,
  });
});

// POST /auth/phone/verify
// Body: { phone, otp }
export const oauthVerifyPhone = asyncHandler(async (req, res) => {
  const data = await oauthVerifyPhoneService({
    userId: req.user._id,
    ...req.body,
  });

  res.status(200).json({
    message: "Phone verified successfully.",
    data,
  });
});

// POST /auth/oauth/link/google
// Body: { idToken }
export const oauthLinkGoogle = asyncHandler(async (req, res) => {
  const user = await oauthLinkGoogleService({ userId: req.user._id, ...req.body });
  res.status(200).json({
    data: buildAuthUserResponse(user),
  });
});

// POST /auth/oauth/link/apple
// Body: { identityToken, nonce? }
export const oauthLinkApple = asyncHandler(async (req, res) => {
  const user = await oauthLinkAppleService({ userId: req.user._id, ...req.body });
  res.status(200).json({
    data: buildAuthUserResponse(user),
  });
});

// DELETE /auth/oauth/unlink/google
export const oauthUnlinkGoogle = asyncHandler(async (req, res) => {
  const user = await oauthUnlinkProviderService({
    userId: req.user._id,
    provider: authProviderEnum.GOOGLE,
  });
  res.status(200).json({
    data: buildAuthUserResponse(user),
  });
});

// DELETE /auth/oauth/unlink/apple
export const oauthUnlinkApple = asyncHandler(async (req, res) => {
  const user = await oauthUnlinkProviderService({
    userId: req.user._id,
    provider: authProviderEnum.APPLE,
  });
  res.status(200).json({
    data: buildAuthUserResponse(user),
  });
});

// POST /auth/oauth/set-password
// Body: { newPassword, cNewPassword }
export const oauthSetPassword = asyncHandler(async (req, res) => {
  await oauthSetPasswordService({ userId: req.user._id, newPassword: req.body.newPassword });
  res.status(200).json({
    status: "success",
    message: "Password set successfully",
  });
});
