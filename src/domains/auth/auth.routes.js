// src/domains/auth/auth.routes.js
import { Router } from "express";
import {
  signup,
  resendOtp,
  verifyPhone,
  login,
  refreshToken,
  logout,
  forgetPassword,
  verifyPasswordResetCode,
  resetPassword,
  sendGuestOtp,
  verifyGuestOtp,
  oauthGoogleLogin,
  oauthAppleLogin,
  oauthSendOtp,
  oauthVerifyPhone,
  oauthLinkGoogle,
  oauthLinkApple,
  oauthUnlinkGoogle,
  oauthUnlinkApple,
  oauthSetPassword,
  mergeGuest,
} from "./auth.controller.js";
import {
  signupValidator,
  resendOtpValidator,
  verifyPhoneValidator,
  loginValidator,
  forgetPasswordValidator,
  verifyResetCodeValidator,
  resetPasswordValidator,
  guestSendOtpValidator,
  guestVerifyOtpValidator,
  oauthGoogleLoginValidator,
  oauthAppleLoginValidator,
  oauthSendOtpValidator,
  oauthVerifyPhoneValidator,
  oauthLinkGoogleValidator,
  oauthLinkAppleValidator,
  oauthSetPasswordValidator,
} from "./auth.validators.js";
import {
  strictAuthLimiter,
  otpLimiter,
} from "../../shared/middlewares/rateLimitMiddleware.js";
import {
  onlySocialProfileCompletionPhone,
  protect,
} from "./auth.middleware.js";

const router = Router();

// Auth routes — strict limiter for credential-based attempts
router.post("/signup", strictAuthLimiter, signupValidator, signup);
router.post("/login", strictAuthLimiter, loginValidator, login);
router.post("/verify-phone", strictAuthLimiter, verifyPhoneValidator, verifyPhone);
router.post("/verify-reset-code", strictAuthLimiter, verifyResetCodeValidator, verifyPasswordResetCode);
router.post("/reset-password", strictAuthLimiter, resetPasswordValidator, resetPassword);

// OTP-sending routes — stricter limiter
router.post("/resend-otp", otpLimiter, resendOtpValidator, resendOtp);
router.post("/guest/send-otp", otpLimiter, guestSendOtpValidator, sendGuestOtp);
router.post("/forget-password", otpLimiter, forgetPasswordValidator, forgetPassword);

// Guest verify (strict)
router.post("/guest/verify-phone", strictAuthLimiter, guestVerifyOtpValidator, verifyGuestOtp);

// Token management (already behind JWT or low-risk)
router.post("/refresh-token", refreshToken);
router.post("/logout", protect, logout);

// OAuth routes
router.post("/oauth/google", oauthGoogleLoginValidator, oauthGoogleLogin);
router.post("/oauth/apple", oauthAppleLoginValidator, oauthAppleLogin);

router.post(
  "/phone/send-otp",
  protect,
  onlySocialProfileCompletionPhone,
  oauthSendOtpValidator,
  oauthSendOtp,
);
router.post(
  "/phone/verify",
  protect,
  onlySocialProfileCompletionPhone,
  oauthVerifyPhoneValidator,
  oauthVerifyPhone,
);

// Link / unlink providers
router.post(
  "/oauth/link/google",
  protect,
  oauthLinkGoogleValidator,
  oauthLinkGoogle,
);
router.post(
  "/oauth/link/apple",
  protect,
  oauthLinkAppleValidator,
  oauthLinkApple,
);
router.delete("/oauth/unlink/google", protect, oauthUnlinkGoogle);
router.delete("/oauth/unlink/apple", protect, oauthUnlinkApple);

// Set password (enable SYSTEM login)
router.post(
  "/oauth/set-password",
  protect,
  oauthSetPasswordValidator,
  oauthSetPassword,
);

// Merge all guest data (cart + favorites + addresses) into user
router.post("/merge-guest", protect, mergeGuest);

export default router;
