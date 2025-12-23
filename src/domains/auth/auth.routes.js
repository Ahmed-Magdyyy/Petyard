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
import { authRateLimiter } from "../../shared/middlewares/rateLimitMiddleware.js";
import { onlySocialProfileCompletionPhone, protect } from "./auth.middleware.js";

const router = Router();

// Apply rate limiter to all auth routes
router.use(authRateLimiter);

// Auth routes
router.post("/signup", signupValidator, signup);
router.post("/resend-otp", resendOtpValidator, resendOtp);
router.post("/verify-phone", verifyPhoneValidator, verifyPhone);
router.post("/guest/send-otp", guestSendOtpValidator, sendGuestOtp);
router.post("/guest/verify-phone", guestVerifyOtpValidator, verifyGuestOtp);
router.post("/login", loginValidator, login);
router.post("/refresh-token", refreshToken);
router.post("/logout", protect, logout);
router.post("/forget-password", forgetPasswordValidator, forgetPassword);
router.post(
  "/verify-reset-code",
  verifyResetCodeValidator,
  verifyPasswordResetCode
);
router.post("/reset-password", resetPasswordValidator, resetPassword);

// OAuth routes
router.post("/oauth/google", oauthGoogleLoginValidator, oauthGoogleLogin);
router.post("/oauth/apple", oauthAppleLoginValidator, oauthAppleLogin);

router.post(
  "/phone/send-otp",
  protect,
  onlySocialProfileCompletionPhone,
  oauthSendOtpValidator,
  oauthSendOtp
);
router.post(
  "/phone/verify",
  protect,
  onlySocialProfileCompletionPhone,
  oauthVerifyPhoneValidator,
  oauthVerifyPhone
);

// Link / unlink providers
router.post(
  "/oauth/link/google",
  protect,
  oauthLinkGoogleValidator,
  oauthLinkGoogle
);
router.post(
  "/oauth/link/apple",
  protect,
  oauthLinkAppleValidator,
  oauthLinkApple
);
router.delete("/oauth/unlink/google", protect, oauthUnlinkGoogle);
router.delete("/oauth/unlink/apple", protect, oauthUnlinkApple);

// Set password (enable SYSTEM login)
router.post(
  "/oauth/set-password",
  protect,
  oauthSetPasswordValidator,
  oauthSetPassword
);

export default router;
